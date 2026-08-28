import { useState }                              from 'react'
import { type ReactNode }                        from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm }                               from 'react-hook-form'
import { zodResolver }                           from '@hookform/resolvers/zod'
import { z }                                     from 'zod'
import { format, addMinutes }                    from 'date-fns'
import { Plus, Send, RefreshCw, AlertTriangle }  from 'lucide-react'
import { toast }                                 from 'sonner'
import { cn }                                    from '@/lib/utils'
import { supabase }                              from '@/lib/supabase'
import { pushSessionSchedule }                   from '@/lib/backend'
import { Button }   from '@/components/ui/button'
import { Badge }    from '@/components/ui/badge'
import { Input }    from '@/components/ui/input'
import { Label }    from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell,
  TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import type { Session, Course, Device,} from '@/types/database'

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionWithRelations = Session & {
  course: { code: string; name: string } | null
  device: { name: string; location: string } | null
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const adHocSchema = z.object({
  course_id:              z.string().min(1, 'Course is required'),
  date:                   z.string().min(1, 'Date is required'),
  start_time:             z.string().min(1, 'Start time is required'),
  duration_minutes:       z.number().int()
                            .min(30,  'Minimum 30 minutes')
                            .max(480, 'Maximum 8 hours'),
  late_threshold_minutes: z.number().int()
                            .min(0,   'Cannot be negative')
                            .max(120, 'Maximum 120 minutes'),
})

type AdHocValues = z.infer<typeof adHocSchema>

// ─── Shared style ─────────────────────────────────────────────────────────────

const nativeSelectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm ' +
  'shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

// ─── Query functions ──────────────────────────────────────────────────────────

async function fetchSessions(
  status: Session['status'] | 'all',
): Promise<SessionWithRelations[]> {
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  let query = supabase
    .from('sessions')
    .select('*, course:courses(code, name), device:devices(name, location)')
    .gte('scheduled_start', sevenDaysAgo.toISOString())
    .order('scheduled_start', { ascending: false })
    .limit(100)

  if (status !== 'all') query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as SessionWithRelations[]
}

async function fetchCourses(): Promise<Course[]> {
  const { data, error } = await supabase.from('courses').select('*').order('code')
  if (error) throw error
  return data ?? []
}

async function fetchActiveDevice(): Promise<Device | null> {
  const { data, error } = await supabase
    .from('devices').select('*').eq('is_active', true).maybeSingle()
  if (error) throw error
  return data
}

async function createAdHocSession(
  values: AdHocValues,
  deviceId: string,
): Promise<Session> {
  const start = new Date(`${values.date}T${values.start_time}`)
  const end   = addMinutes(start, values.duration_minutes)

  const insert = {
    course_id:              values.course_id,
    device_id:              deviceId,
    scheduled_start:        start.toISOString(),
    scheduled_end:          end.toISOString(),
    duration_minutes:       values.duration_minutes,
    late_threshold_minutes: values.late_threshold_minutes,
    is_adhoc:               true,
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('sessions')
    .insert([insert])
    .select()
    .single()

  if (error) {
    if (error.code === '23P01') {
      throw new Error(
        'This session overlaps with an existing session on the same device. ' +
        'Adjust the start time or duration.'
      )
    }
    throw error
  }
  return data as Session
}

async function cancelSession(sessionId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('sessions')
    .update({ status: 'cancelled' })
    .eq('id', sessionId)
  if (error) throw error
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Field({
  id, label, error, children,
}: {
  id: string; label: string; error?: string; children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm">{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

function SessionStatusBadge({ status }: { status: Session['status'] }) {
  const map: Record<Session['status'], { label: string; className: string }> = {
    scheduled: { label: 'Scheduled', className: 'bg-accent text-accent-foreground' },
    completed: { label: 'Completed', className: 'bg-status-present text-status-present-fg' },
    cancelled: { label: 'Cancelled', className: 'bg-muted text-muted-foreground' },
  }
  const { label, className } = map[status]
  return <Badge className={cn('border-0 text-xs font-medium', className)}>{label}</Badge>
}

function SessionTypeBadge({
  isAdhoc, isManual,
}: {
  isAdhoc: boolean; isManual: boolean
}) {
  if (isManual) return (
    <Badge className="border-0 text-xs font-medium bg-status-late text-status-late-fg gap-1">
      <AlertTriangle className="h-3 w-3" />Manual
    </Badge>
  )
  if (isAdhoc) return (
    <Badge className="border-0 text-xs font-medium bg-muted text-muted-foreground">
      Ad-hoc
    </Badge>
  )
  return (
    <Badge className="border-0 text-xs font-medium bg-muted text-muted-foreground">
      Recurring
    </Badge>
  )
}

// ─── AdHocDialog ─────────────────────────────────────────────────────────────

function AdHocDialog({
  open, onOpenChange, courses, device, onCreated,
}: {
  open:         boolean
  onOpenChange: (v: boolean) => void
  courses:      Course[]
  device:       Device | null
  onCreated:    () => void
}) {
  const {
    register, handleSubmit, setValue, reset,
    formState: { errors, isSubmitting },
  } = useForm<AdHocValues>({
    resolver:      zodResolver(adHocSchema),
    defaultValues: {
      course_id:              '',
      date:                   format(new Date(), 'yyyy-MM-dd'),
      start_time:             '08:00',
      duration_minutes:       120,
      late_threshold_minutes: 30,
    },
  })

  const mutation = useMutation({
    mutationFn: (values: AdHocValues) => {
      if (!device) throw new Error('No device available.')
      return createAdHocSession(values, device.id)
    },
    onSuccess: () => {
      toast.success('Ad-hoc session created successfully.')
      reset()
      onOpenChange(false)
      onCreated()
    },
    onError: (err: Error) => { toast.error(err.message) },
  })

  function handleOpenChange(v: boolean) {
    if (!v) reset()
    onOpenChange(v)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Create ad-hoc session</DialogTitle>
          <DialogDescription className="text-sm">
            A one-off session outside the recurring schedule. It will be pushed
            to the device automatically on creation.
          </DialogDescription>
        </DialogHeader>

        {!device && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            No device found. A device record must exist before creating a session.
          </div>
        )}

        <form
          onSubmit={handleSubmit(v => mutation.mutate(v))}
          className="flex flex-col gap-4 pt-1"
          noValidate
        >
          <Field id="course_id" label="Course" error={errors.course_id?.message}>
            <select
              id="course_id"
              className={nativeSelectClass}
              defaultValue=""
              onChange={e =>
                setValue('course_id', e.target.value, { shouldValidate: true })
              }
            >
              <option value="" disabled>Select a course…</option>
              {courses.map(c => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field id="date" label="Date" error={errors.date?.message}>
              <Input
                id="date"
                type="date"
                className="text-sm"
                {...register('date')}
              />
            </Field>
            <Field id="start_time" label="Start time" error={errors.start_time?.message}>
              <Input id="start_time" type="time" className="text-sm" {...register('start_time')} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field
              id="duration_minutes"
              label="Duration (min)"
              error={errors.duration_minutes?.message}
            >
              <Input
                id="duration_minutes"
                type="number" min={30} max={480}
                className="text-sm"
                {...register('duration_minutes', { valueAsNumber: true })}
              />
            </Field>
            <Field
              id="late_threshold_minutes"
              label="Late after (min)"
              error={errors.late_threshold_minutes?.message}
            >
              <Input
                id="late_threshold_minutes" type="number" min={0} max={120}
                className="text-sm" {...register('late_threshold_minutes', { valueAsNumber: true })}
              />
            </Field>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" className="text-sm"
              onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit"
              className="text-sm bg-primary text-primary-foreground"
              disabled={!device || mutation.isPending || isSubmitting}>
              {mutation.isPending ? 'Creating…' : 'Create session'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Sessions() {
  const queryClient = useQueryClient()

  const [statusFilter, setStatusFilter] = useState<Session['status'] | 'all'>('all')
  const [adHocOpen, setAdHocOpen]       = useState(false)

  const { data: sessions = [], isLoading, refetch } = useQuery({
    queryKey:        ['sessions', statusFilter],
    queryFn:         () => fetchSessions(statusFilter),
    refetchInterval: 60_000,
  })

  const { data: courses = [] } = useQuery({
    queryKey: ['courses'], queryFn: fetchCourses, staleTime: 5 * 60_000,
  })

  const { data: activeDevice } = useQuery({
    queryKey: ['devices', 'active'], queryFn: fetchActiveDevice, refetchInterval: 30_000,
  })

  const pushMutation = useMutation({
  mutationFn: () => {
    if (!activeDevice) throw new Error('No device found.')
    return pushSessionSchedule(activeDevice.id)
  },
  onSuccess: (result) => {
    toast.success(
      `Schedule pushed — ${result.pushed} ` +
      `${result.pushed === 1 ? 'session' : 'sessions'} delivered to device.`
    )
  },
  onError: (err: Error) => {
    toast.error(err.message ?? 'Failed to push schedule. Check device connection.')
  },
})

  const cancelMutation = useMutation({
    mutationFn: cancelSession,
    onSuccess: () => {
      toast.success('Session cancelled.')
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
    onError: (err: Error) => {
      toast.error(err.message ?? 'Failed to cancel session.')
    },
  })

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-border px-8">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Sessions</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Schedule and ad-hoc sessions</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-2 text-sm"
            onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4" />Refresh
          </Button>
          <Button
            variant="outline" size="sm" className="gap-2 text-sm"
            disabled={!activeDevice || pushMutation.isPending}
            onClick={() => pushMutation.mutate()}
          >
            <Send className="h-4 w-4" />
            {pushMutation.isPending ? 'Pushing…' : 'Push schedule'}
          </Button>
          <Button size="sm"
            className="gap-2 text-sm bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => setAdHocOpen(true)}>
            <Plus className="h-4 w-4" />Ad-hoc session
          </Button>
        </div>
      </header>

      <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-8 py-4">
        <Select
          value={statusFilter}
          onValueChange={v => setStatusFilter(v as Session['status'] | 'all')}
        >
          <SelectTrigger className="w-44 text-sm">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="scheduled">Scheduled</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">
          Last 7 days + upcoming · {sessions.length}{' '}
          {sessions.length === 1 ? 'session' : 'sessions'}
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex flex-col gap-3 p-8">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex h-64 items-center justify-center">
            <div className="text-center">
              <p className="text-base font-medium text-foreground">No sessions found</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create an ad-hoc session or push the schedule to populate this view.
              </p>
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-sm">Course</TableHead>
                <TableHead className="text-sm">Device</TableHead>
                <TableHead className="text-sm">Start</TableHead>
                <TableHead className="text-sm">End</TableHead>
                <TableHead className="text-sm">Duration</TableHead>
                <TableHead className="text-sm">Status</TableHead>
                <TableHead className="text-sm">Type</TableHead>
                <TableHead className="w-20 text-sm">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map(session => (
                <TableRow
                  key={session.id}
                  className={cn(session.is_manual && 'bg-status-late/10')}
                >
                  <TableCell>
                    <p className="text-sm font-medium text-foreground">
                      {session.course?.code ?? '—'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {session.course?.name ?? ''}
                    </p>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {session.device?.location ?? '—'}
                  </TableCell>
                  <TableCell>
                    <span className="font-data text-sm text-foreground">
                      {format(new Date(session.scheduled_start), 'dd MMM, HH:mm')}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="font-data text-sm text-muted-foreground">
                      {format(new Date(session.scheduled_end), 'HH:mm')}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {session.duration_minutes} min
                  </TableCell>
                  <TableCell>
                    <SessionStatusBadge status={session.status} />
                  </TableCell>
                  <TableCell>
                    <SessionTypeBadge
                      isAdhoc={session.is_adhoc}
                      isManual={session.is_manual}
                    />
                  </TableCell>
                  <TableCell>
                    {session.status === 'scheduled' && (
                      <Button
                        variant="ghost" size="sm"
                        className="text-xs text-muted-foreground hover:text-destructive h-7 px-2"
                        disabled={cancelMutation.isPending}
                        onClick={() => cancelMutation.mutate(session.id)}
                      >
                        Cancel
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <AdHocDialog
        open={adHocOpen}
        onOpenChange={setAdHocOpen}
        courses={courses}
        device={activeDevice ?? null}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['sessions'] })}
      />
    </div>
  )
}
