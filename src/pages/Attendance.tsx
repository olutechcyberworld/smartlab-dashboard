import { useState, useEffect }             from 'react'
import { useQuery }                         from '@tanstack/react-query'
import { format }                           from 'date-fns'
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
import type { AttendanceRecord, AttendanceStatus, Session } from '@/types/database'

// ─── Local types ──────────────────────────────────────────────────────────────

type SessionWithRelations = Session & {
  course: { code: string; name: string } | null
  device: { name: string; location: string } | null
}

type RecordWithStudent = AttendanceRecord & {
  student: { full_name: string; matric_number: string } | null
  session: { scheduled_start: string; scheduled_end: string } | null
}

type HistoricalFilters = {
  date:   string
  status: AttendanceStatus | 'all'
  search: string
}

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

async function fetchHistoricalAttendance(
  filters: HistoricalFilters
): Promise<RecordWithStudent[]> {
  let query = supabase
    .from('attendance_records')
    .select(`
      *,
      student:students(full_name, matric_number),
      session:sessions(scheduled_start, scheduled_end)
    `)
    .order('created_at', { ascending: false })
    .limit(200)

  if (filters.status !== 'all') {
    query = query.eq('attendance_status', filters.status)
  }

  if (filters.date) {
    query = query
      .gte('created_at', `${filters.date}T00:00:00.000Z`)
      .lte('created_at', `${filters.date}T23:59:59.999Z`)
  }

  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as RecordWithStudent[]
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function exportCSV(records: RecordWithStudent[], filename: string) {
  const header = ['Student Name', 'Matric Number', 'Status', 'Scanned At', 'Session Start']
  const rows   = records.map(r => [
    `"${r.student?.full_name    ?? ''}"`,
    `"${r.student?.matric_number ?? ''}"`,
    r.attendance_status,
    r.scanned_at            ? format(new Date(r.scanned_at),              'yyyy-MM-dd HH:mm:ss') : '',
    r.session?.scheduled_start  ? format(new Date(r.session.scheduled_start), 'yyyy-MM-dd HH:mm')    : '',
  ])

  const csv  = [header.join(','), ...rows.map(r => r.join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
  a.click()
  URL.revokeObjectURL(url)
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
  const [filters, setFilters]         = useState<HistoricalFilters>({
    date:   format(new Date(), 'yyyy-MM-dd'),
    status: 'all',
    search: '',
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

  // Historical records
  const { data: historicalData = [], isLoading: historicalLoading } = useQuery({
    queryKey: ['attendance', 'historical', filters.date, filters.status],
    queryFn:  () => fetchHistoricalAttendance(filters),
    enabled:  activeTab === 'historical',
  })

  // Client-side name/matric search on top of server-filtered results
  const historicalRecords = filters.search.trim()
    ? historicalData.filter(r =>
        r.student?.full_name.toLowerCase().includes(filters.search.toLowerCase()) ||
        r.student?.matric_number.toLowerCase().includes(filters.search.toLowerCase())
      )
    : historicalData

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
          <div className="flex flex-shrink-0 flex-wrap items-center gap-3">
            <Input
              type="date"
              value={filters.date}
              onChange={e => setFilters(f => ({ ...f, date: e.target.value }))}
              className="w-44 text-sm"
            />
            <Select
              value={filters.status}
              onValueChange={v => setFilters(f => ({
                ...f, status: v as AttendanceStatus | 'all'
              }))}
            >
              <SelectTrigger className="w-40 text-sm">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="present">Present</SelectItem>
                <SelectItem value="late">Late</SelectItem>
                <SelectItem value="absent">Absent</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Search name or matric…"
              value={filters.search}
              onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
              className="w-56 text-sm"
            />
            <div className="ml-auto">
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-sm"
                disabled={historicalRecords.length === 0}
                onClick={() => exportCSV(
                  historicalRecords,
                  `attendance-${filters.date || format(new Date(), 'yyyy-MM-dd')}.csv`
                )}
              >
                <Download className="h-4 w-4" />
                Export CSV
              </Button>
            </div>
          </div>

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
              <AttendanceTable records={historicalRecords} showSession />
            )}
          </div>

          {historicalData.length === 200 && (
            <p className="mt-2 flex-shrink-0 text-right text-xs text-muted-foreground">
              Showing the 200 most recent records. Narrow the date filter to see earlier entries.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}