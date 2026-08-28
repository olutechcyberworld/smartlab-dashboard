import { useState }                                    from 'react'
import { type ReactNode }                              from 'react'
import { useQuery, useMutation, useQueryClient }       from '@tanstack/react-query'
import { useForm }                                     from 'react-hook-form'
import { zodResolver }                                 from '@hookform/resolvers/zod'
import { z }                                           from 'zod'
import { format }                                      from 'date-fns'
import { Plus, MoreHorizontal, Fingerprint, Trash2, RefreshCw } from 'lucide-react'
import { toast }                                       from 'sonner'
import { cn }                                          from '@/lib/utils'
import { supabase }                                    from '@/lib/supabase'
import { sendEnrollmentCommand, sendEnrollmentDelete } from '@/lib/backend'
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
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type {
  Student, Department, AcademicLevel,
  Device, EnrollmentStatus, StudentInsert,
} from '@/types/database'

// ─── Types ────────────────────────────────────────────────────────────────────

type StudentRow = Student & {
  department: Pick<Department, 'name' | 'code'> | null
  level:      Pick<AcademicLevel, 'code' | 'display_name'> | null
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const addStudentSchema = z
  .object({
    full_name:     z.string().min(2,  'Full name is required'),
    matric_number: z.string().min(3,  'Matric number is required'),
    department_id: z.string().min(1,  'Department is required'),
    level_id:      z.string().min(1,  'Level is required'),
    email:         z.string().email('Enter a valid email address').or(z.literal('')),
    phone_number:  z.string().min(10, 'Enter at least 10 digits').or(z.literal('')),
  })
  .refine(
    d => (d.email?.length ?? 0) > 0 || (d.phone_number?.length ?? 0) > 0,
    { message: 'At least one of email or phone number is required', path: ['email'] }
  )

type AddStudentValues = z.infer<typeof addStudentSchema>

// ─── Shared style ─────────────────────────────────────────────────────────────

const nativeSelectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm ' +
  'shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

// ─── Query functions ──────────────────────────────────────────────────────────

async function fetchStudents(
  search: string,
  status: EnrollmentStatus | 'all',
): Promise<StudentRow[]> {
  let query = supabase
    .from('students')
    .select('*, department:departments(name, code), level:academic_levels(code, display_name)')
    .order('created_at', { ascending: false })

  if (status !== 'all') query = query.eq('enrollment_status', status)
  if (search.trim()) {
    query = query.or(
      `full_name.ilike.%${search.trim()}%,matric_number.ilike.%${search.trim()}%`
    )
  }

  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as StudentRow[]
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

async function fetchOnlineDevice(): Promise<Device | null> {
  const { data, error } = await supabase
    .from('devices')
    .select('*')
    .eq('is_active', true)
    .eq('status', 'online')
    .maybeSingle()
  if (error) throw error
  return data
}

async function createStudent(
  values:   AddStudentValues,
  photoUrl: string | null,
): Promise<Student> {
  const insert: StudentInsert = {
    full_name:     values.full_name,
    matric_number: values.matric_number,
    department_id: values.department_id,
    level_id:      values.level_id,
    email:         values.email        || null,
    phone_number:  values.phone_number || null,
    photo_url:     photoUrl,
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('students')
    .insert(insert)
    .select()
    .single()
  if (error) {
    if (error.code === '23505') throw new Error('A student with that matric number already exists.')
    throw error
  }
  return data as Student
}
// ─── Sub-components ───────────────────────────────────────────────────────────

function EnrollmentStatusBadge({ status }: { status: EnrollmentStatus }) {
  const map: Record<EnrollmentStatus, { label: string; className: string }> = {
    provisional: { label: 'Provisional', className: 'bg-muted text-muted-foreground' },
    enrolled:    { label: 'Enrolled',    className: 'bg-status-present text-status-present-fg' },
    inactive:    { label: 'Inactive',    className: 'bg-status-absent  text-status-absent-fg'  },
  }
  const { label, className } = map[status]
  return <Badge className={cn('border-0 text-xs font-medium', className)}>{label}</Badge>
}

// Local label+input+error layout helper used in dialogs
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

// ─── AddStudentDialog ─────────────────────────────────────────────────────────

function AddStudentDialog({
  open, onOpenChange, departments, levels, onCreated,
}: {
  open:         boolean
  onOpenChange: (v: boolean) => void
  departments:  Department[]
  levels:       AcademicLevel[]
  onCreated:    (student: Student) => void
}) {
  const [photoFile,    setPhotoFile]    = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [uploading,    setUploading]    = useState(false)

  const {
    register, handleSubmit, setValue, reset,
    formState: { errors, isSubmitting },
  } = useForm<AddStudentValues>({
    resolver:      zodResolver(addStudentSchema),
    defaultValues: {
      full_name: '', matric_number: '',
      department_id: '', level_id: '',
      email: '', phone_number: '',
    },
  })

  function handlePhotoChange(e: { target: HTMLInputElement & EventTarget }) {
  const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      toast.error('Only image files are accepted for the passport photo.')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error('Photo must be under 2 MB.')
      return
    }

    setPhotoFile(file)
    setPhotoPreview(URL.createObjectURL(file))
  }

  function clearPhoto() {
    setPhotoFile(null)
    if (photoPreview) {
      URL.revokeObjectURL(photoPreview)
      setPhotoPreview(null)
    }
  }

  async function uploadPhoto(matricNumber: string): Promise<string | null> {
    if (!photoFile) return null

    const ext      = photoFile.name.split('.').pop() ?? 'jpg'
    const path     = `${matricNumber.replace(/\//g, '-')}.${ext}`

    const { error } = await supabase.storage
      .from('student-photos')
      .upload(path, photoFile, { upsert: true })

    if (error) {
      toast.error('Photo upload failed. Student profile will be created without a photo.')
      return null
    }

    const { data } = supabase.storage.from('student-photos').getPublicUrl(path)
    return data.publicUrl
  }

  const mutation = useMutation({
  mutationFn: async (values: AddStudentValues) => {
    setUploading(true)
    const photoUrl = await uploadPhoto(values.matric_number)
    setUploading(false)
    return createStudent(values, photoUrl)
  },
  onSuccess: (student) => {
    toast.success(`${student.full_name} added as provisional student.`)
    handleOpenChange(false)
    onCreated(student)
  },
  onError: (err: Error) => {
    setUploading(false)
    toast.error(err.message)
  },
})

  function handleOpenChange(v: boolean) {
    if (!v) {
      reset()
      clearPhoto()
    }
    onOpenChange(v)
  }

  const isBusy = uploading || mutation.isPending || isSubmitting

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Add new student</DialogTitle>
          <DialogDescription className="text-sm">
            Creates a provisional profile. Fingerprint enrollment is a separate step.
            Passport photo is optional and can be added later.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit(v => mutation.mutate(v))}
          className="flex flex-col gap-4 pt-2"
          noValidate
        >
          {/* Passport photo */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-sm">Passport photo (optional)</Label>
            <div className="flex items-center gap-3">
              <div className={cn(
                'h-16 w-16 flex-shrink-0 rounded-lg border-2 border-dashed border-border',
                'flex items-center justify-center overflow-hidden bg-muted/40',
              )}>
                {photoPreview ? (
                  <img
                    src={photoPreview}
                    alt="Passport preview"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground text-center px-1">
                    No photo
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1.5 min-w-0">
                <label
                  htmlFor="passport-upload"
                  className={cn(
                    'inline-flex h-8 cursor-pointer items-center rounded-md border border-input',
                    'bg-background px-3 text-xs font-medium text-foreground',
                    'hover:bg-accent hover:text-accent-foreground transition-colors',
                  )}
                >
                  {photoPreview ? 'Change photo' : 'Choose photo'}
                </label>
                <input
                  id="passport-upload"
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={handlePhotoChange}
                />
                {photoPreview && (
                  <button
                    type="button"
                    onClick={clearPhoto}
                    className="text-xs text-muted-foreground hover:text-destructive transition-colors text-left"
                  >
                    Remove
                  </button>
                )}
                <p className="text-xs text-muted-foreground">
                  JPG, PNG or WEBP. Max 2 MB.
                </p>
              </div>
            </div>
          </div>

          <Field id="full_name" label="Full name" error={errors.full_name?.message}>
            <Input
              id="full_name" className="text-sm"
              placeholder="Surname Firstname Middlename"
              aria-invalid={!!errors.full_name}
              {...register('full_name')}
            />
          </Field>

          <Field id="matric_number" label="Matric number" error={errors.matric_number?.message}>
            <Input
              id="matric_number" className="text-sm font-data"
              placeholder="e.g. CSC/2021/001"
              aria-invalid={!!errors.matric_number}
              {...register('matric_number')}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field id="department_id" label="Department" error={errors.department_id?.message}>
              <select
                id="department_id"
                className={nativeSelectClass}
                defaultValue=""
                onChange={e =>
                  setValue('department_id', e.target.value, { shouldValidate: true })
                }
              >
                <option value="" disabled>Select…</option>
                {departments.map(d => (
                  <option key={d.id} value={d.id}>{d.code} — {d.name}</option>
                ))}
              </select>
            </Field>

            <Field id="level_id" label="Level" error={errors.level_id?.message}>
              <select
                id="level_id"
                className={nativeSelectClass}
                defaultValue=""
                onChange={e =>
                  setValue('level_id', e.target.value, { shouldValidate: true })
                }
              >
                <option value="" disabled>Select…</option>
                {levels.map(l => (
                  <option key={l.id} value={l.id}>{l.display_name}</option>
                ))}
              </select>
            </Field>
          </div>

          <Field id="email" label="Email" error={errors.email?.message}>
            <Input
              id="email" type="email" className="text-sm"
              placeholder="student@institution.edu.ng"
              aria-invalid={!!errors.email}
              {...register('email')}
            />
          </Field>

          <Field id="phone_number" label="Phone number" error={errors.phone_number?.message}>
            <Input
              id="phone_number" type="tel" className="text-sm font-data"
              placeholder="e.g. 08012345678"
              aria-invalid={!!errors.phone_number}
              {...register('phone_number')}
            />
          </Field>

          <DialogFooter className="pt-2">
            <Button
              type="button" variant="outline" className="text-sm"
              onClick={() => handleOpenChange(false)}
              disabled={isBusy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="text-sm bg-primary text-primary-foreground"
              disabled={isBusy}
            >
              {uploading
                ? 'Uploading photo…'
                : mutation.isPending
                  ? 'Adding…'
                  : 'Add student'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
// ─── EnrollDialog ─────────────────────────────────────────────────────────────

function EnrollDialog({
  student, device, onClose,
}: {
  student: StudentRow | null; device: Device | null; onClose: () => void
}) {
  const mutation = useMutation({
    mutationFn: () => {
      if (!student || !device) throw new Error('Missing student or device.')
      return sendEnrollmentCommand({ studentId: student.id, deviceId: device.id })
    },
    onSuccess: () => {
      toast.success('Enrollment command sent. Ask the student to place their finger on the sensor.')
      onClose()
    },
    onError: (err: Error) => {
      toast.error(err.message ?? 'Failed to reach the device. Check that it is online.')
    },
  })

  return (
    <Dialog open={!!student} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Enroll fingerprint</DialogTitle>
          <DialogDescription className="text-sm">
            Sends an enrollment command to the lab device. The student must be
            physically present at the sensor to complete capture.
          </DialogDescription>
        </DialogHeader>

        {student && (
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <p className="text-sm font-medium text-foreground">{student.full_name}</p>
            <p className="font-data text-sm text-muted-foreground mt-0.5">
              {student.matric_number}
            </p>
          </div>
        )}

        {!device && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            No device is currently online. Enrollment requires an active network
            connection to the lab hardware.
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" className="text-sm" onClick={onClose}>Cancel</Button>
          <Button
            className="text-sm bg-primary text-primary-foreground"
            disabled={!device || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Sending…' : 'Send enrollment command'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── DeleteDialog ─────────────────────────────────────────────────────────────

function DeleteDialog({
  student, device, onClose, onDeleted,
}: {
  student:   StudentRow | null; device: Device | null
  onClose:   () => void;        onDeleted: () => void
}) {
  const mutation = useMutation({
    mutationFn: () => {
      if (!student || !device) throw new Error('Missing student or device.')
      if (!student.fingerprint_slot_id) throw new Error('Student has no enrolled fingerprint.')
      return sendEnrollmentDelete({
        studentId:         student.id,
        deviceId:          device.id,
        fingerprintSlotId: student.fingerprint_slot_id,
      })
    },
    onSuccess: () => {
      toast.success(`${student?.full_name} removed from the system.`)
      onDeleted()
      onClose()
    },
    onError: (err: Error) => {
      toast.error(err.message ?? 'Deletion failed. Check that the device is online.')
    },
  })

  return (
    <Dialog open={!!student} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base text-destructive">Delete student</DialogTitle>
          <DialogDescription className="text-sm">
            Permanently removes the student profile and deletes their fingerprint
            template from the device. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {student && (
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <p className="text-sm font-medium text-foreground">{student.full_name}</p>
            <p className="font-data text-sm text-muted-foreground mt-0.5">
              {student.matric_number}
            </p>
            {student.fingerprint_slot_id !== null && (
              <p className="text-xs text-muted-foreground mt-1">
                Fingerprint slot {student.fingerprint_slot_id} will be freed on device.
              </p>
            )}
          </div>
        )}

        {!device && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            No device is currently online. Fingerprint deletion requires an active
            connection to the lab hardware.
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" className="text-sm" onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive" className="text-sm"
            disabled={!device || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Deleting…' : 'Delete student'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Students() {
  const queryClient = useQueryClient()

  const [search, setSearch]               = useState('')
  const [statusFilter, setStatusFilter]   = useState<EnrollmentStatus | 'all'>('all')
  const [addOpen, setAddOpen]             = useState(false)
  const [enrollTarget, setEnrollTarget]   = useState<StudentRow | null>(null)
  const [deleteTarget, setDeleteTarget]   = useState<StudentRow | null>(null)

  const { data: students = [], isLoading, refetch } = useQuery({
    queryKey:        ['students', search, statusFilter],
    queryFn:         () => fetchStudents(search, statusFilter),
    refetchInterval: 30_000,
  })

  const { data: departments = [] } = useQuery({
    queryKey: ['departments'], queryFn: fetchDepartments, staleTime: Infinity,
  })

  const { data: levels = [] } = useQuery({
    queryKey: ['academic_levels'], queryFn: fetchLevels, staleTime: Infinity,
  })

  const { data: onlineDevice } = useQuery({
    queryKey: ['devices', 'online'], queryFn: fetchOnlineDevice, refetchInterval: 30_000,
  })

  function invalidateStudents() {
    queryClient.invalidateQueries({ queryKey: ['students'] })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-border px-8">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Students</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Enrollment and profiles</p>
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
            Add student
          </Button>
        </div>
      </header>

      <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-8 py-4">
        <Input
          placeholder="Search name or matric number…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-72 text-sm"
        />
        <Select
          value={statusFilter}
          onValueChange={v => setStatusFilter(v as EnrollmentStatus | 'all')}
        >
          <SelectTrigger className="w-44 text-sm">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="provisional">Provisional</SelectItem>
            <SelectItem value="enrolled">Enrolled</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">
          {students.length} {students.length === 1 ? 'student' : 'students'}
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex flex-col gap-3 p-8">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : students.length === 0 ? (
          <div className="flex h-64 items-center justify-center">
            <div className="text-center">
              <p className="text-base font-medium text-foreground">No students found</p>
              <p className="text-sm text-muted-foreground mt-1">
                {search || statusFilter !== 'all'
                  ? 'Try adjusting your search or filter.'
                  : 'Add a student to get started.'}
              </p>
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-sm">Name</TableHead>
                <TableHead className="text-sm">Matric No.</TableHead>
                <TableHead className="text-sm">Department</TableHead>
                <TableHead className="text-sm">Level</TableHead>
                <TableHead className="text-sm">Status</TableHead>
                <TableHead className="text-sm">Enrolled</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {students.map(student => (
                <TableRow key={student.id}>
                  <TableCell className="text-sm font-medium text-foreground">
                    {student.full_name}
                  </TableCell>
                  <TableCell>
                    <span className="font-data text-muted-foreground">
                      {student.matric_number}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {student.department?.code ?? '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {student.level?.display_name ?? '—'}
                  </TableCell>
                  <TableCell>
                    <EnrollmentStatusBadge status={student.enrollment_status} />
                  </TableCell>
                  <TableCell>
                    <span className="font-data text-xs text-muted-foreground">
                      {student.enrolled_at
                        ? format(new Date(student.enrolled_at), 'dd MMM yyyy')
                        : '—'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Actions</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        {student.enrollment_status === 'provisional' && (
                          <DropdownMenuItem className="gap-2 text-sm cursor-pointer"
                            onClick={() => setEnrollTarget(student)}>
                            <Fingerprint className="h-4 w-4 text-primary" />
                            Enroll fingerprint
                          </DropdownMenuItem>
                        )}
                        {student.enrollment_status === 'enrolled' && (<>
                          <DropdownMenuItem className="gap-2 text-sm cursor-pointer"
                            onClick={() => setEnrollTarget(student)}>
                            <Fingerprint className="h-4 w-4 text-primary" />
                            Re-enroll fingerprint
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="gap-2 text-sm text-destructive cursor-pointer focus:text-destructive"
                            onClick={() => setDeleteTarget(student)}>
                            <Trash2 className="h-4 w-4" />
                            Delete student
                          </DropdownMenuItem>
                        </>)}
                        {student.enrollment_status === 'inactive' && (
                          <DropdownMenuItem disabled className="text-sm text-muted-foreground">
                            Student is inactive
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <AddStudentDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        departments={departments}
        levels={levels}
        onCreated={invalidateStudents}
      />
      <EnrollDialog
        student={enrollTarget}
        device={onlineDevice ?? null}
        onClose={() => setEnrollTarget(null)}
      />
      <DeleteDialog
        student={deleteTarget}
        device={onlineDevice ?? null}
        onClose={() => setDeleteTarget(null)}
        onDeleted={invalidateStudents}
      />
    </div>
  )
}