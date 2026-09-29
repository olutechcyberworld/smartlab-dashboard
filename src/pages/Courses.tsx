import { useMemo, useState, type ReactNode }        from 'react'
import { useQuery, useMutation, useQueryClient }   from '@tanstack/react-query'
import { useForm }                                 from 'react-hook-form'
import { zodResolver }                             from '@hookform/resolvers/zod'
import { z }                                       from 'zod'
import { Plus, RefreshCw, Users }                  from 'lucide-react'
import { toast }                                   from 'sonner'
import { cn }                                      from '@/lib/utils'
import { supabase }                                from '@/lib/supabase'
import { Button }   from '@/components/ui/button'
import { Badge }    from '@/components/ui/badge'
import { Input }    from '@/components/ui/input'
import { Label }    from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell,
  TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import type {
  Course, CourseInsert, Department, AcademicLevel, EnrollmentStatus,
} from '@/types/database'

// ─── Types ────────────────────────────────────────────────────────────────────

type CourseRow = Omit<Course, 'department' | 'level'> & {
  department:      { name: string; code: string } | null
  level:           { code: string; display_name: string } | null
  // Embedded aggregate: one element, filtered to active registrations only.
  student_courses: { count: number }[]
}

type RegistrationRow = {
  student_id: string
  status:     'active' | 'dropped'
  student: {
    full_name:         string
    matric_number:     string
    enrollment_status: EnrollmentStatus
  } | null
}

type CandidateStudent = {
  id:                string
  full_name:         string
  matric_number:     string
  enrollment_status: EnrollmentStatus
}

/** One row of the registration checklist, whatever its origin. */
type ChecklistStudent = CandidateStudent & { registered: boolean }

// ─── Schema ───────────────────────────────────────────────────────────────────

const courseSchema = z.object({
  code:          z.string().trim().min(3, 'Course code is required').max(15, 'Maximum 15 characters'),
  name:          z.string().trim().min(3, 'Course title is required').max(120, 'Maximum 120 characters'),
  department_id: z.string().min(1, 'Department is required'),
  level_id:      z.string().min(1, 'Level is required'),
  semester:      z.enum(['1', '2']),
  academic_year: z
    .string()
    .regex(/^\d{4}\/\d{4}$/, 'Use the format 2025/2026')
    .refine(
      v => Number(v.slice(5)) === Number(v.slice(0, 4)) + 1,
      'The two years must be consecutive, for example 2025/2026',
    ),
})

type CourseValues = z.infer<typeof courseSchema>

// ─── Shared style ─────────────────────────────────────────────────────────────

const nativeSelectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm ' +
  'shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Nigerian academic years begin around September. */
function defaultAcademicYear(now = new Date()): string {
  const y = now.getFullYear()
  return now.getMonth() >= 7 ? `${y}/${y + 1}` : `${y - 1}/${y}`
}

function describeSupabaseError(error: { code?: string; message: string }): string {
  if (error.code === '42501') {
    return (
      'Permission denied by the database. Apply migration ' +
      '004_dashboard_course_management.sql in the Supabase SQL editor.'
    )
  }
  return error.message
}

// ─── Query functions ──────────────────────────────────────────────────────────

async function fetchCourseRows(): Promise<CourseRow[]> {
  const { data, error } = await supabase
    .from('courses')
    .select(
      '*, department:departments(name, code), level:academic_levels(code, display_name), student_courses(count)'
    )
    .eq('student_courses.status', 'active')
    .order('academic_year', { ascending: false })
    .order('code')

  if (error) throw error
  return (data ?? []) as unknown as CourseRow[]
}

async function fetchDepartments(): Promise<Department[]> {
  const { data, error } = await supabase.from('departments').select('*').order('name')
  if (error) throw error
  return data ?? []
}

async function fetchLevels(): Promise<AcademicLevel[]> {
  const { data, error } = await supabase
    .from('academic_levels')
    .select('*')
    .order('institution_type')
    .order('sort_order')
  if (error) throw error
  return data ?? []
}

async function fetchRegistrations(courseId: string): Promise<RegistrationRow[]> {
  const { data, error } = await supabase
    .from('student_courses')
    .select('student_id, status, student:students(full_name, matric_number, enrollment_status)')
    .eq('course_id', courseId)
  if (error) throw error
  return (data ?? []) as unknown as RegistrationRow[]
}

async function fetchCandidates(
  course: CourseRow,
  includeAll: boolean,
): Promise<CandidateStudent[]> {
  let query = supabase
    .from('students')
    .select('id, full_name, matric_number, enrollment_status')
    .neq('enrollment_status', 'inactive')
    .order('full_name')

  if (!includeAll) {
    query = query
      .eq('department_id', course.department_id)
      .eq('level_id',      course.level_id)
  }

  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as unknown as CandidateStudent[]
}

async function createCourse(values: CourseValues): Promise<Course> {
  const insert: CourseInsert = {
    code:          values.code.trim().replace(/\s+/g, ' ').toUpperCase(),
    name:          values.name.trim(),
    department_id: values.department_id,
    level_id:      values.level_id,
    semester:      values.semester === '1' ? 1 : 2,
    academic_year: values.academic_year,
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('courses')
    .insert([insert])
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      throw new Error(
        `${insert.code} already exists for ${insert.academic_year}, ` +
        `semester ${insert.semester}.`
      )
    }
    throw new Error(describeSupabaseError(error))
  }
  return data as Course
}

/**
 * Applies a registration change as two idempotent steps.
 * Additions are upserts so that re-registering a previously dropped student
 * flips the existing row back to 'active' instead of violating
 * UNIQUE (student_id, course_id). Removals are soft: status = 'dropped'.
 */
async function saveRegistrations(
  courseId: string,
  toAdd:    string[],
  toDrop:   string[],
): Promise<void> {
  if (toAdd.length > 0) {
    const rows = toAdd.map(student_id => ({
      student_id, course_id: courseId, status: 'active',
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from('student_courses')
      .upsert(rows, { onConflict: 'student_id,course_id' })
    if (error) throw new Error(describeSupabaseError(error))
  }

  if (toDrop.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from('student_courses')
      .update({ status: 'dropped' })
      .eq('course_id', courseId)
      .in('student_id', toDrop)
    if (error) throw new Error(describeSupabaseError(error))
  }
}

// ─── Small components ─────────────────────────────────────────────────────────

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

function TableSkeleton() {
  return (
    <div className="p-6 flex flex-col gap-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  )
}

// ─── AddCourseDialog ──────────────────────────────────────────────────────────

function AddCourseDialog({
  open, onOpenChange, departments, levels, onCreated,
}: {
  open:         boolean
  onOpenChange: (v: boolean) => void
  departments:  Department[]
  levels:       AcademicLevel[]
  onCreated:    () => void
}) {
  const {
    register, handleSubmit, reset,
    formState: { errors, isSubmitting },
  } = useForm<CourseValues>({
    resolver:      zodResolver(courseSchema),
    defaultValues: {
      code:          '',
      name:          '',
      department_id: '',
      level_id:      '',
      semester:      '1',
      academic_year: defaultAcademicYear(),
    },
  })

  const mutation = useMutation({
    mutationFn: createCourse,
    onSuccess: (course) => {
      toast.success(`${course.code} created.`)
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
          <DialogTitle className="text-base">Add course</DialogTitle>
          <DialogDescription className="text-sm">
            Each row is one course offering. The same code in a different
            semester or academic year is a separate course.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit(v => mutation.mutate(v))}
          className="flex flex-col gap-4 pt-1"
          noValidate
        >
          <div className="grid grid-cols-[9rem_1fr] gap-3">
            <Field id="code" label="Course code" error={errors.code?.message}>
              <Input id="code" placeholder="CSC 201" className="text-sm uppercase" {...register('code')} />
            </Field>
            <Field id="name" label="Course title" error={errors.name?.message}>
              <Input id="name" placeholder="Digital Electronics" className="text-sm" {...register('name')} />
            </Field>
          </div>

          <Field id="department_id" label="Department" error={errors.department_id?.message}>
            <select id="department_id" className={nativeSelectClass} {...register('department_id')}>
              <option value="" disabled>Select a department…</option>
              {departments.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </Field>

          <Field id="level_id" label="Level" error={errors.level_id?.message}>
            <select id="level_id" className={nativeSelectClass} {...register('level_id')}>
              <option value="" disabled>Select a level…</option>
              {levels.map(l => (
                <option key={l.id} value={l.id}>{l.display_name}</option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field id="semester" label="Semester" error={errors.semester?.message}>
              <select id="semester" className={nativeSelectClass} {...register('semester')}>
                <option value="1">First semester</option>
                <option value="2">Second semester</option>
              </select>
            </Field>
            <Field id="academic_year" label="Academic year" error={errors.academic_year?.message}>
              <Input id="academic_year" placeholder="2025/2026" className="text-sm" {...register('academic_year')} />
            </Field>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" className="text-sm"
              onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit"
              className="text-sm bg-primary text-primary-foreground"
              disabled={mutation.isPending || isSubmitting}>
              {mutation.isPending ? 'Creating…' : 'Create course'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── ManageStudentsDialog ─────────────────────────────────────────────────────
// Mounted with key={course.id} by the page, so all local state is fresh per course.

function ManageStudentsDialog({
  course, onClose, onSaved,
}: {
  course:  CourseRow
  onClose: () => void
  onSaved: () => void
}) {
  const [search, setSearch]         = useState('')
  const [includeAll, setIncludeAll] = useState(false)
  // null means "no edits yet": the selection then mirrors the server state.
  const [edited, setEdited]         = useState<Set<string> | null>(null)

  const { data: registrations = [], isLoading: regLoading } = useQuery({
    queryKey: ['student_courses', course.id],
    queryFn:  () => fetchRegistrations(course.id),
    staleTime: 0,
  })

  const { data: candidates = [], isLoading: candLoading } = useQuery({
    queryKey: ['students', 'course-candidates', course.id, includeAll],
    queryFn:  () => fetchCandidates(course, includeAll),
    staleTime: 0,
  })

  const activeIds = useMemo(
    () => new Set(registrations.filter(r => r.status === 'active').map(r => r.student_id)),
    [registrations],
  )

  const selected = edited ?? activeIds

  // Union of candidates and currently registered students. Registered students
  // outside the department/level filter (carry-overs, inactive records) must
  // stay visible, otherwise they could never be reviewed or dropped.
  const checklist = useMemo<ChecklistStudent[]>(() => {
    const byId = new Map<string, ChecklistStudent>()

    for (const s of candidates) {
      byId.set(s.id, { ...s, registered: activeIds.has(s.id) })
    }
    for (const r of registrations) {
      if (r.status !== 'active' || !r.student || byId.has(r.student_id)) continue
      byId.set(r.student_id, {
        id:                r.student_id,
        full_name:         r.student.full_name,
        matric_number:     r.student.matric_number,
        enrollment_status: r.student.enrollment_status,
        registered:        true,
      })
    }

    const term = search.trim().toLowerCase()
    return [...byId.values()]
      .filter(s =>
        !term ||
        s.full_name.toLowerCase().includes(term) ||
        s.matric_number.toLowerCase().includes(term)
      )
      .sort((a, b) => a.full_name.localeCompare(b.full_name))
  }, [candidates, registrations, activeIds, search])

  const toAdd  = [...selected].filter(id => !activeIds.has(id))
  const toDrop = [...activeIds].filter(id => !selected.has(id))
  const dirty  = toAdd.length > 0 || toDrop.length > 0

  function toggle(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    setEdited(next)
  }

  function setShown(checked: boolean) {
    const next = new Set(selected)
    for (const s of checklist) {
      // Inactive students are never bulk-added, but may be bulk-removed.
      if (checked && s.enrollment_status === 'inactive') continue
      if (checked) next.add(s.id); else next.delete(s.id)
    }
    setEdited(next)
  }

  const mutation = useMutation({
    mutationFn: () => saveRegistrations(course.id, toAdd, toDrop),
    onSuccess: () => {
      toast.success(
        `Registration updated: ${toAdd.length} added, ${toDrop.length} removed.`
      )
      onSaved()
      onClose()
    },
    onError: (err: Error) => { toast.error(err.message) },
  })

  const isLoading = regLoading || candLoading

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">
            {course.code} · Registered students
          </DialogTitle>
          <DialogDescription className="text-sm">
            Absent marking uses this list when a session closes: registered
            students with no scan are recorded absent. Register students before
            the session ends.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Search name or matric…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-56 text-sm"
          />
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={includeAll}
              onChange={e => setIncludeAll(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Include other departments and levels
          </label>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" className="text-xs"
              onClick={() => setShown(true)}>
              Select shown
            </Button>
            <Button type="button" variant="outline" size="sm" className="text-xs"
              onClick={() => setShown(false)}>
              Clear shown
            </Button>
          </div>
        </div>

        <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border">
          {isLoading ? (
            <TableSkeleton />
          ) : checklist.length === 0 ? (
            <div className="flex h-32 items-center justify-center px-6 text-center">
              <p className="text-sm text-muted-foreground">
                No students match. Enable the option above to list students from
                other departments and levels.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {checklist.map(s => (
                <li key={s.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
                    <input
                      type="checkbox"
                      checked={selected.has(s.id)}
                      onChange={() => toggle(s.id)}
                      className="h-4 w-4 accent-primary"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {s.full_name}
                    </span>
                    <span className="font-data text-xs text-muted-foreground">
                      {s.matric_number}
                    </span>
                    {s.enrollment_status === 'provisional' && (
                      <Badge className="border-0 bg-muted text-xs font-medium text-muted-foreground">
                        No fingerprint yet
                      </Badge>
                    )}
                    {s.enrollment_status === 'inactive' && (
                      <Badge className="border-0 bg-status-absent text-xs font-medium text-status-absent-fg">
                        Inactive
                      </Badge>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {selected.size} registered
          {dirty && ` · pending: ${toAdd.length} to add, ${toDrop.length} to remove`}
          . Students without an enrolled fingerprint cannot scan and will be
          recorded absent.
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" className="text-sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            className="text-sm bg-primary text-primary-foreground"
            disabled={!dirty || mutation.isPending || isLoading}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Saving…' : 'Save registration'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Courses() {
  const queryClient = useQueryClient()

  const [search, setSearch]             = useState('')
  const [addOpen, setAddOpen]           = useState(false)
  const [manageTarget, setManageTarget] = useState<CourseRow | null>(null)

  const { data: courses = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['courses', 'list'],
    queryFn:  fetchCourseRows,
  })

  const { data: departments = [] } = useQuery({
    queryKey: ['departments'], queryFn: fetchDepartments, staleTime: Infinity,
  })

  const { data: levels = [] } = useQuery({
    queryKey: ['academic_levels'], queryFn: fetchLevels, staleTime: Infinity,
  })

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return courses
    return courses.filter(c =>
      c.code.toLowerCase().includes(term) || c.name.toLowerCase().includes(term)
    )
  }, [courses, search])

  function invalidateCourses() {
    // Prefix match: also refreshes the ['courses'] cache used by Sessions and Attendance.
    queryClient.invalidateQueries({ queryKey: ['courses'] })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">

      <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-border px-8">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Courses</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Course offerings and student registration
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-2 text-sm"
            onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button size="sm"
            className="gap-2 text-sm bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            Add course
          </Button>
        </div>
      </header>

      <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-8 py-4">
        <Input
          placeholder="Search code or title…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-72 text-sm"
        />
      </div>

      <div className="flex-1 overflow-auto px-8 py-5">
        <div className="overflow-hidden rounded-lg border border-border">
          {isLoading ? (
            <TableSkeleton />
          ) : isError ? (
            <div className="flex h-48 items-center justify-center px-6 text-center">
              <p className="text-sm text-destructive">
                {(error as Error).message}
              </p>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2">
              <p className="text-sm font-medium text-foreground">No courses yet</p>
              <p className="text-sm text-muted-foreground">
                Use Add course to create the first one.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-sm">Code</TableHead>
                  <TableHead className="text-sm">Title</TableHead>
                  <TableHead className="text-sm">Department</TableHead>
                  <TableHead className="text-sm">Level</TableHead>
                  <TableHead className="text-sm">Semester</TableHead>
                  <TableHead className="text-sm">Year</TableHead>
                  <TableHead className="text-sm">Registered</TableHead>
                  <TableHead className="text-sm text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map(c => {
                  const registered = c.student_courses?.[0]?.count ?? 0
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="text-sm font-medium text-foreground">{c.code}</TableCell>
                      <TableCell className="text-sm text-foreground">{c.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {c.department?.code ?? '—'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {c.level?.code ?? '—'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {c.semester === 1 ? 'First' : 'Second'}
                      </TableCell>
                      <TableCell>
                        <span className="font-data text-sm text-muted-foreground">
                          {c.academic_year}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge className={cn(
                          'border-0 text-xs font-medium',
                          registered > 0
                            ? 'bg-status-present text-status-present-fg'
                            : 'bg-status-late text-status-late-fg'
                        )}>
                          {registered === 0 ? 'None' : registered}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" className="gap-2 text-xs"
                          onClick={() => setManageTarget(c)}>
                          <Users className="h-3.5 w-3.5" />
                          Manage students
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </div>

        {!isLoading && courses.some(c => (c.student_courses?.[0]?.count ?? 0) === 0) && (
          <p className="mt-3 text-xs text-muted-foreground">
            A course marked None has no registered students, so no one will be
            recorded absent for its sessions.
          </p>
        )}
      </div>

      <AddCourseDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        departments={departments}
        levels={levels}
        onCreated={invalidateCourses}
      />

      {manageTarget && (
        <ManageStudentsDialog
          key={manageTarget.id}
          course={manageTarget}
          onClose={() => setManageTarget(null)}
          onSaved={invalidateCourses}
        />
      )}
    </div>
  )
}
