import { useState, useEffect, useMemo }    from 'react'
import { useQuery }                         from '@tanstack/react-query'
import { format, addDays, subDays }         from 'date-fns'
import { Download, RefreshCw }              from 'lucide-react'
import { toast }                            from 'sonner'
import { cn }                               from '@/lib/utils'
import { supabase }                         from '@/lib/supabase'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button }                           from '@/components/ui/button'
import { Badge }                            from '@/components/ui/badge'
import { Input }                            from '@/components/ui/input'
import { Skeleton }                         from '@/components/ui/skeleton'
import {
  Select, SelectContent,
  SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell,
  TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import type { AttendanceRecord, AttendanceStatus, Course, Session } from '@/types/database'

// ─── Local types ──────────────────────────────────────────────────────────────

type SessionWithRelations = Session & {
  course: { code: string; name: string } | null
  device: { name: string; location: string } | null
}

type SessionInfo = {
  scheduled_start: string
  scheduled_end:   string
  course_id:       string | null
  course:          { code: string; name: string } | null
}

// `session` is absent on live records, which are fetched without the join.
type RecordWithStudent = Omit<AttendanceRecord, 'student' | 'session'> & {
  student:  { full_name: string; matric_number: string } | null
  session?: SessionInfo | null
}

// Shape returned by PostgREST for the historical query (embed key is the table name).
type RawHistoricalRow = Omit<AttendanceRecord, 'student' | 'session'> & {
  student:  { full_name: string; matric_number: string } | null
  sessions: {
    scheduled_start: string
    scheduled_end:   string
    course_id:       string | null
    courses:         { code: string; name: string } | null
  } | null
}

/** 'all' = every course, 'manual' = sessions with no course (BTN2), otherwise a course id. */
type CourseFilter = 'all' | 'manual' | string

type HistoricalFilters = {
  dateFrom: string
  dateTo:   string
  course:   CourseFilter
  status:   AttendanceStatus | 'all'
  search:   string
}

type HistoricalResult = {
  records:   RecordWithStudent[]
  truncated: boolean
}

// PostgREST caps a single response (1000 rows by default), so history is read in pages.
const HISTORY_PAGE_SIZE = 1000
const HISTORY_MAX_ROWS  = 20_000
const DISPLAY_LIMIT     = 500

const HISTORY_SELECT = `
  *,
  student:students(full_name, matric_number),
  sessions!inner(scheduled_start, scheduled_end, course_id, courses(code, name))
`

// ─── Query functions ──────────────────────────────────────────────────────────

async function fetchCurrentSession(): Promise<SessionWithRelations | null> {
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('sessions')
    .select('*, course:courses(code, name), device:devices(name, location)')
    .lte('scheduled_start', now)
    .gte('scheduled_end',   now)
    .eq('status', 'scheduled')
    .maybeSingle()

  if (error) throw error
  return data as SessionWithRelations | null
}

async function fetchSessionAttendance(
  sessionId: string
): Promise<RecordWithStudent[]> {
  const { data, error } = await supabase
    .from('attendance_records')
    .select('*, student:students(full_name, matric_number)')
    .eq('session_id', sessionId)
    .in('attendance_status', ['present', 'late'])
    .order('scanned_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as RecordWithStudent[]
}

/** Local-time midnight at the start of `day` (yyyy-MM-dd), as a UTC ISO string. */
function dayStartIso(day: string): string {
  return new Date(`${day}T00:00:00`).toISOString()
}

/** Exclusive upper bound: local midnight at the start of the day AFTER `day`. */
function nextDayStartIso(day: string): string {
  return addDays(new Date(`${day}T00:00:00`), 1).toISOString()
}

async function fetchCourses(): Promise<Course[]> {
  const { data, error } = await supabase.from('courses').select('*').order('code')
  if (error) throw error
  return data ?? []
}

/**
 * Range and course filters are applied to the SESSION, not to the attendance row.
 *  - attendance_records.scanned_at is NULL for absent rows, so filtering on it
 *    would silently drop every absence.
 *  - attendance_records.created_at is the server insert time, which for
 *    offline-queue records is the sync time and for absent rows is when the
 *    backend job ran, so it does not reflect when the class took place.
 */
async function fetchHistoricalAttendance(
  filters: HistoricalFilters
): Promise<HistoricalResult> {
  const from = dayStartIso(filters.dateFrom)
  const to   = nextDayStartIso(filters.dateTo)

  const collected: RecordWithStudent[] = []
  let truncated = false

  for (let offset = 0; ; offset += HISTORY_PAGE_SIZE) {
    if (offset >= HISTORY_MAX_ROWS) { truncated = true; break }

    let query = supabase
      .from('attendance_records')
      .select(HISTORY_SELECT)
      .gte('sessions.scheduled_start', from)
      .lt('sessions.scheduled_start',  to)
      .order('id', { ascending: true }) // unique, so pages never overlap or skip
      .range(offset, offset + HISTORY_PAGE_SIZE - 1)

    if (filters.status !== 'all') {
      query = query.eq('attendance_status', filters.status)
    }
    if (filters.course === 'manual') {
      query = query.is('sessions.course_id', null)
    } else if (filters.course !== 'all') {
      query = query.eq('sessions.course_id', filters.course)
    }

    const { data, error } = await query
    if (error) throw error

    const page = (data ?? []) as unknown as RawHistoricalRow[]
    for (const row of page) {
      const { sessions, ...rest } = row
      collected.push({
        ...rest,
        session: sessions && {
          scheduled_start: sessions.scheduled_start,
          scheduled_end:   sessions.scheduled_end,
          course_id:       sessions.course_id,
          course:          sessions.courses,
        },
      })
    }

    if (page.length < HISTORY_PAGE_SIZE) break
  }

  collected.sort((a, b) =>
    (b.session?.scheduled_start ?? '').localeCompare(a.session?.scheduled_start ?? '') ||
    (a.student?.full_name ?? '').localeCompare(b.student?.full_name ?? '')
  )

  return { records: collected, truncated }
}

// ─── CSV export ───────────────────────────────────────────────────────────────

/**
 * Quotes a field and neutralises spreadsheet formula injection: a value that
 * begins with = + - @ (or a control character) is prefixed with an apostrophe
 * so Excel and Sheets treat it as text.
 */
function csvCell(value: string | null | undefined): string {
  let text = value ?? ''
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

function exportCSV(records: RecordWithStudent[], filename: string) {
  const header = [
    'Course Code', 'Course Name', 'Session Date', 'Session Start',
    'Student Name', 'Matric Number', 'Status', 'Scanned At',
  ]

  // Chronological order reads naturally in a spreadsheet.
  const ordered = [...records].sort((a, b) =>
    (a.session?.scheduled_start ?? '').localeCompare(b.session?.scheduled_start ?? '') ||
    (a.student?.full_name ?? '').localeCompare(b.student?.full_name ?? '')
  )

  const rows = ordered.map(r => [
    r.session?.course?.code ?? (r.session?.course_id ? '' : 'MANUAL'),
    r.session?.course?.name ?? '',
    r.session?.scheduled_start ? format(new Date(r.session.scheduled_start), 'yyyy-MM-dd') : '',
    r.session?.scheduled_start ? format(new Date(r.session.scheduled_start), 'HH:mm')      : '',
    r.student?.full_name    ?? '',
    r.student?.matric_number ?? '',
    r.attendance_status,
    r.scanned_at ? format(new Date(r.scanned_at), 'yyyy-MM-dd HH:mm:ss') : '',
  ].map(csvCell).join(','))

  // BOM so Excel decodes UTF-8 names correctly; CRLF per RFC 4180.
  const csv  = '\uFEFF' + [header.map(csvCell).join(','), ...rows].join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function exportFilename(
  filters: HistoricalFilters,
  courses: Course[],
): string {
  let scope = 'all-courses'
  if (filters.course === 'manual') {
    scope = 'unassigned-sessions'
  } else if (filters.course !== 'all') {
    const c = courses.find(x => x.id === filters.course)
    if (c) scope = `${c.code}-${c.academic_year}-S${c.semester}`
  }
  const safe  = scope.replace(/[^A-Za-z0-9_-]+/g, '-')
  const range = filters.dateFrom === filters.dateTo
    ? filters.dateFrom
    : `${filters.dateFrom}_to_${filters.dateTo}`
  return `attendance_${safe}_${range}.csv`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AttendanceStatus }) {
  const map: Record<AttendanceStatus, { label: string; className: string }> = {
    present: { label: 'Present', className: 'bg-status-present text-status-present-fg' },
    late:    { label: 'Late',    className: 'bg-status-late    text-status-late-fg'    },
    absent:  { label: 'Absent',  className: 'bg-status-absent  text-status-absent-fg'  },
  }
  const { label, className } = map[status]
  return (
    <Badge className={cn('border-0 font-medium text-xs', className)}>
      {label}
    </Badge>
  )
}

function StatCard({
  label, value, highlight = false,
}: {
  label: string; value: number; highlight?: boolean
}) {
  return (
    <div className={cn(
      'rounded-lg border border-border bg-card p-4',
      highlight && 'border-primary/30 bg-primary/5'
    )}>
      <p className="text-2xl font-semibold text-foreground">{value}</p>
      <p className="text-sm text-muted-foreground mt-0.5">{label}</p>
    </div>
  )
}

function AttendanceTable({
  records, showSession,
}: {
  records: RecordWithStudent[]; showSession: boolean
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-sm">Student</TableHead>
          <TableHead className="text-sm">Matric No.</TableHead>
          <TableHead className="text-sm">Status</TableHead>
          <TableHead className="text-sm">Scanned At</TableHead>
          {showSession && <TableHead className="text-sm">Course</TableHead>}
          {showSession && <TableHead className="text-sm">Session</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map(record => (
          <TableRow key={record.id}>
            <TableCell className="text-sm font-medium text-foreground">
              {record.student?.full_name ?? '—'}
            </TableCell>
            <TableCell>
              <span className="font-data text-muted-foreground">
                {record.student?.matric_number ?? '—'}
              </span>
            </TableCell>
            <TableCell>
              <StatusBadge status={record.attendance_status} />
            </TableCell>
            <TableCell>
              <span className="font-data text-muted-foreground">
                {record.scanned_at
                  ? format(new Date(record.scanned_at), 'HH:mm:ss')
                  : '—'}
              </span>
            </TableCell>
            {showSession && (
              <TableCell className="text-sm text-muted-foreground">
                {record.session?.course?.code ??
                  (record.session ? 'Manual' : '—')}
              </TableCell>
            )}
            {showSession && (
              <TableCell>
                <span className="font-data text-muted-foreground text-xs">
                  {record.session?.scheduled_start
                    ? format(new Date(record.session.scheduled_start), 'dd MMM, HH:mm')
                    : '—'}
                </span>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function TableSkeleton() {
  return (
    <div className="p-6 flex flex-col gap-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  )
}

function NoSessionState({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="mt-5 flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-card py-20">
      <p className="text-base font-medium text-foreground">No active session</p>
      <p className="text-sm text-muted-foreground text-center max-w-sm">
        A session must be scheduled and currently within its time window for live
        attendance to display. Check the Sessions page to confirm one is active.
      </p>
      <Button variant="outline" size="sm" className="mt-2 gap-2 text-sm" onClick={onRefresh}>
        <RefreshCw className="h-4 w-4" />
        Check again
      </Button>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Attendance() {
  const [activeTab, setActiveTab]     = useState<'live' | 'historical'>('live')
  const [liveRecords, setLiveRecords] = useState<RecordWithStudent[]>([])
  const [filters, setFilters]         = useState<HistoricalFilters>(() => {
    const today = format(new Date(), 'yyyy-MM-dd')
    return { dateFrom: today, dateTo: today, course: 'all', status: 'all', search: '' }
  })

  // Current active session (re-checks every minute for session transitions)
  const {
    data:      currentSession,
    isLoading: sessionLoading,
    refetch:   refetchSession,
  } = useQuery({
    queryKey:        ['sessions', 'current'],
    queryFn:         fetchCurrentSession,
    refetchInterval: 60_000,
  })

  // Initial attendance records for the live session
  const { data: initialRecords, isLoading: recordsLoading } = useQuery({
    queryKey: ['attendance', 'session', currentSession?.id],
    queryFn:  () => fetchSessionAttendance(currentSession!.id),
    enabled:  !!currentSession?.id,
  })

  // Seed live records from the initial fetch
  useEffect(() => {
    if (initialRecords) setLiveRecords(initialRecords)
  }, [initialRecords])

  // Supabase Realtime subscription — fires on new scans during an active session
  useEffect(() => {
    if (!currentSession?.id) return

    const channel = supabase
      .channel(`attendance-live-${currentSession.id}`)
      .on(
        'postgres_changes',
        {
          event:  'INSERT',
          schema: 'smart_attendance_system',
          table:  'attendance_records',
          filter: `session_id=eq.${currentSession.id}`,
        },
        async (payload) => {
          const { data } = await supabase
            .from('attendance_records')
            .select('*, student:students(full_name, matric_number)')
            .eq('id', (payload.new as { id: string }).id)
            .single()

          if (data) {
            const record = data as RecordWithStudent
            setLiveRecords(prev => [record, ...prev])
            toast.success(
              `${record.student?.full_name ?? 'Unknown'} — ${record.attendance_status}`
            )
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [currentSession?.id])

  // Courses for the history filter (same cache key as the Sessions page)
  const { data: courses = [] } = useQuery({
    queryKey: ['courses'], queryFn: fetchCourses, staleTime: 5 * 60_000,
  })

  // Historical records: range and course are applied server-side, on the session
  const rangeValid =
    filters.dateFrom !== '' && filters.dateTo !== '' && filters.dateFrom <= filters.dateTo

  const { data: historical, isLoading: historicalLoading } = useQuery({
    queryKey: [
      'attendance', 'historical',
      filters.dateFrom, filters.dateTo, filters.course, filters.status,
    ],
    queryFn: () => fetchHistoricalAttendance(filters),
    enabled: activeTab === 'historical' && rangeValid,
  })

  // Client-side name/matric search on top of the server-filtered range.
  // The export uses exactly this list, so what is on screen is what is downloaded.
  const historicalRecords = useMemo(() => {
    const all  = historical?.records ?? []
    const term = filters.search.trim().toLowerCase()
    if (!term) return all
    return all.filter(r =>
      r.student?.full_name.toLowerCase().includes(term) ||
      r.student?.matric_number.toLowerCase().includes(term)
    )
  }, [historical, filters.search])

  function applyPreset(days: number) {
    const today = new Date()
    setFilters(f => ({
      ...f,
      dateFrom: format(subDays(today, days - 1), 'yyyy-MM-dd'),
      dateTo:   format(today, 'yyyy-MM-dd'),
    }))
  }

  // Live stats derived from realtime state
  const presentCount = liveRecords.filter(r => r.attendance_status === 'present').length
  const lateCount    = liveRecords.filter(r => r.attendance_status === 'late').length

  return (
    <div className="flex h-full flex-col overflow-hidden">

      {/* Page header */}
      <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-border px-8">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Attendance</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Live and historical records</p>
        </div>
      </header>

      {/* Tab shell */}
      <Tabs
        value={activeTab}
        onValueChange={v => setActiveTab(v as 'live' | 'historical')}
        className="flex flex-1 flex-col overflow-hidden"
      >
        <div className="flex-shrink-0 px-8 pt-5">
          <TabsList className="h-9">
            <TabsTrigger value="live" className="text-sm gap-2">
              <span className={cn(
                'h-2 w-2 rounded-full transition-colors',
                currentSession
                  ? 'bg-green-500 animate-live-pulse'
                  : 'bg-muted-foreground/30'
              )} />
              Live
            </TabsTrigger>
            <TabsTrigger value="historical" className="text-sm">
              Historical
            </TabsTrigger>
          </TabsList>
        </div>

        {/* ── Live ──────────────────────────────────────────────────────── */}
        <TabsContent
          value="live"
          className="mt-0 flex flex-1 flex-col overflow-hidden px-8 pb-8 pt-5"
        >
          {sessionLoading ? (
            <TableSkeleton />
          ) : !currentSession ? (
            <NoSessionState onRefresh={refetchSession} />
          ) : (
            <>
              {/* Session banner */}
              <div className="rounded-lg border border-border bg-card p-4 flex items-start justify-between gap-4">
                <div>
                  <p className="text-base font-medium text-foreground">
                    {currentSession.course?.code}
                    {currentSession.course?.name ? ` — ${currentSession.course.name}` : ''}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {format(new Date(currentSession.scheduled_start), 'h:mm a')}
                    {' – '}
                    {format(new Date(currentSession.scheduled_end), 'h:mm a')}
                    {currentSession.device?.location
                      ? ` · ${currentSession.device.location}`
                      : ''}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2 text-sm font-medium text-green-600">
                  <span className="h-2 w-2 rounded-full bg-green-500 animate-live-pulse" />
                  Active
                </div>
              </div>

              {/* Stats */}
              <div className="mt-4 grid grid-cols-3 gap-3">
                <StatCard label="Present"      value={presentCount}       highlight />
                <StatCard label="Late"         value={lateCount} />
                <StatCard label="Total scanned" value={liveRecords.length} />
              </div>

              {/* Records table */}
              <div className="mt-4 flex-1 overflow-auto rounded-lg border border-border">
                {recordsLoading ? (
                  <TableSkeleton />
                ) : liveRecords.length === 0 ? (
                  <div className="flex h-48 items-center justify-center">
                    <p className="text-sm text-muted-foreground">
                      No scans recorded yet for this session.
                    </p>
                  </div>
                ) : (
                  <AttendanceTable records={liveRecords} showSession={false} />
                )}
              </div>
            </>
          )}
        </TabsContent>

        {/* ── Historical ─────────────────────────────────────────────────── */}
        <TabsContent
          value="historical"
          className="mt-0 flex flex-1 flex-col overflow-hidden px-8 pb-8 pt-5"
        >
          {/* Filters row */}
          <div className="flex flex-shrink-0 flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">From</span>
              <Input
                type="date"
                value={filters.dateFrom}
                max={filters.dateTo || undefined}
                onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value }))}
                className="w-40 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">To</span>
              <Input
                type="date"
                value={filters.dateTo}
                min={filters.dateFrom || undefined}
                onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value }))}
                className="w-40 text-sm"
              />
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => applyPreset(1)}>Today</Button>
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => applyPreset(7)}>7 days</Button>
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => applyPreset(30)}>30 days</Button>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Course</span>
              <Select
                value={filters.course}
                onValueChange={v => setFilters(f => ({ ...f, course: v }))}
              >
                <SelectTrigger className="w-64 text-sm">
                  <SelectValue placeholder="All courses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All courses</SelectItem>
                  {courses.map(c => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.code} · {c.academic_year} · S{c.semester}
                    </SelectItem>
                  ))}
                  <SelectItem value="manual">Unassigned (manual sessions)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Status</span>
              <Select
                value={filters.status}
                onValueChange={v => setFilters(f => ({
                  ...f, status: v as AttendanceStatus | 'all'
                }))}
              >
                <SelectTrigger className="w-36 text-sm">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="present">Present</SelectItem>
                  <SelectItem value="late">Late</SelectItem>
                  <SelectItem value="absent">Absent</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Input
              placeholder="Search name or matric…"
              value={filters.search}
              onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
              className="w-52 text-sm"
            />

            <div className="ml-auto">
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-sm"
                disabled={historicalRecords.length === 0}
                onClick={() => exportCSV(
                  historicalRecords,
                  exportFilename(filters, courses),
                )}
              >
                <Download className="h-4 w-4" />
                Export CSV
              </Button>
            </div>
          </div>

          {!rangeValid && (
            <p className="mt-2 flex-shrink-0 text-xs text-destructive">
              Choose a start date that is on or before the end date.
            </p>
          )}

          {/* Records table */}
          <div className="mt-4 flex-1 overflow-auto rounded-lg border border-border">
            {historicalLoading ? (
              <TableSkeleton />
            ) : historicalRecords.length === 0 ? (
              <div className="flex h-48 items-center justify-center">
                <p className="text-sm text-muted-foreground">
                  No records found for the selected filters.
                </p>
              </div>
            ) : (
              <AttendanceTable
                records={historicalRecords.slice(0, DISPLAY_LIMIT)}
                showSession
              />
            )}
          </div>

          {historical && (
            <div className="mt-2 flex-shrink-0 space-y-1 text-right text-xs text-muted-foreground">
              <p>
                {historicalRecords.length} record{historicalRecords.length === 1 ? '' : 's'}
                {historicalRecords.length > DISPLAY_LIMIT &&
                  ` · showing the first ${DISPLAY_LIMIT}; Export CSV includes all ${historicalRecords.length}`}
              </p>
              {historical.truncated && (
                <p className="text-destructive">
                  The range exceeds {HISTORY_MAX_ROWS.toLocaleString()} records and was cut off.
                  Narrow the dates or choose a single course.
                </p>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}