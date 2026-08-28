// All types are explicit inline definitions.
// No Pick<>, Partial<>, or & intersections inside the Database type
// to avoid TypeScript parse confusion with the current tsconfig.

export type EnrollmentStatus = 'provisional' | 'enrolled' | 'inactive'
export type AttendanceStatus = 'present' | 'late' | 'absent'
export type SyncType         = 'realtime' | 'queue_flush' | 'backend_generated'
export type DayOfWeek        =
  | 'monday' | 'tuesday' | 'wednesday'
  | 'thursday' | 'friday' | 'saturday' | 'sunday'

// ─── Relation summary types ───────────────────────────────────────────────────
// Explicit inline objects replace Pick<> in interface definitions.

type DeptSummary    = { id: string; name: string; code: string }
type LevelSummary   = { id: string; code: string; display_name: string }
type CourseSummary  = { id: string; code: string; name: string }
type DeviceSummary  = { id: string; name: string; location: string }
type StudentSummary = { id: string; full_name: string; matric_number: string }
type SessionSummary = { scheduled_start: string; scheduled_end: string }

// ─── Row interfaces ───────────────────────────────────────────────────────────

export interface InstitutionConfig {
  id:               string
  institution_name: string
  institution_type: 'university' | 'polytechnic' | 'college'
  created_at:       string
}

export interface Department {
  id:         string
  name:       string
  code:       string
  created_at: string
}

export interface AcademicLevel {
  id:               string
  code:             string
  display_name:     string
  institution_type: 'university' | 'polytechnic' | 'college'
  sort_order:       number
}

export interface Device {
  id:                string
  name:              string
  location:          string
  mqtt_client_id:    string
  firmware_version:  string | null
  status:            'online' | 'offline'
  last_seen:         string | null
  last_session_sync: string | null
  ip_address:        string | null
  is_active:         boolean
  created_at:        string
  updated_at:        string
}

export interface Student {
  id:                  string
  full_name:           string
  matric_number:       string
  department_id:       string
  level_id:            string
  fingerprint_slot_id: number | null
  photo_url:           string | null
  email:               string | null
  phone_number:        string | null
  enrollment_status:   EnrollmentStatus
  enrolled_at:         string | null
  created_at:          string
  updated_at:          string
  department?:         DeptSummary
  level?:              LevelSummary
}

export interface Course {
  id:            string
  code:          string
  name:          string
  department_id: string
  level_id:      string
  semester:      1 | 2
  academic_year: string
  created_at:    string
  updated_at:    string
  department?:   DeptSummary
  level?:        LevelSummary
}

export interface StudentCourse {
  id:          string
  student_id:  string
  course_id:   string
  status:      'active' | 'dropped'
  enrolled_at: string
  student?:    StudentSummary
  course?:     CourseSummary
}

export interface SessionTemplate {
  id:               string
  course_id:        string
  device_id:        string
  day_of_week:      DayOfWeek
  start_time:       string
  duration_minutes: number
  valid_from:       string
  valid_until:      string
  is_active:        boolean
  created_at:       string
  updated_at:       string
  course?:          CourseSummary
  device?:          DeviceSummary
}

export interface Session {
  id:                     string
  template_id:            string | null
  course_id:              string
  device_id:              string
  scheduled_start:        string
  scheduled_end:          string
  duration_minutes:       number
  late_threshold_minutes: number
  status:                 'scheduled' | 'completed' | 'cancelled'
  is_adhoc:               boolean
  is_manual:              boolean
  created_at:             string
  updated_at:             string
  course?:                CourseSummary
  device?:                DeviceSummary
}

export interface AttendanceRecord {
  id:                string
  student_id:        string
  session_id:        string
  device_id:         string | null
  attendance_status: AttendanceStatus
  sync_type:         SyncType
  scanned_at:        string | null
  synced_at:         string | null
  created_at:        string
  student?:          StudentSummary
  session?:          SessionSummary
}

// ─── Insert types ─────────────────────────────────────────────────────────────

export type StudentInsert = {
  full_name:     string
  matric_number: string
  department_id: string
  level_id:      string
  email?:        string | null
  phone_number?: string | null
  photo_url?:    string | null
}

export type CourseInsert = {
  code:          string
  name:          string
  department_id: string
  level_id:      string
  semester:      1 | 2
  academic_year: string
}

export type SessionInsert = {
  course_id:              string
  device_id:              string
  scheduled_start:        string
  scheduled_end:          string
  duration_minutes:       number
  late_threshold_minutes: number
  is_adhoc?:              boolean
}

export type DepartmentInsert = {
  name: string
  code: string
}

// ─── Update types (named explicitly to avoid inline complexity) ───────────────

type StudentUpdate = {
  full_name?:           string
  matric_number?:       string
  department_id?:       string
  level_id?:            string
  email?:               string | null
  phone_number?:        string | null
  photo_url?:           string | null
  enrollment_status?:   EnrollmentStatus
  fingerprint_slot_id?: number | null
  enrolled_at?:         string | null
}

type SessionUpdate = {
  status?:                'scheduled' | 'completed' | 'cancelled'
  scheduled_start?:       string
  scheduled_end?:         string
  duration_minutes?:      number
  late_threshold_minutes?: number
  is_adhoc?:              boolean
  is_manual?:             boolean
}

// ─── Database type ────────────────────────────────────────────────────────────

export type Database = {
  smart_attendance_system: {
    Tables: {
      institution_config: {
        Row:    InstitutionConfig
        Insert: { institution_name: string; institution_type: 'university' | 'polytechnic' | 'college' }
        Update: { institution_name?: string; institution_type?: 'university' | 'polytechnic' | 'college' }
      }
      departments: {
        Row:    Department
        Insert: DepartmentInsert
        Update: { name?: string; code?: string }
      }
      academic_levels: {
        Row:    AcademicLevel
        Insert: never
        Update: never
      }
      devices: {
        Row:    Device
        Insert: never
        Update: never
      }
      students: {
        Row:    Student
        Insert: StudentInsert
        Update: StudentUpdate
      }
      courses: {
        Row:    Course
        Insert: CourseInsert
        Update: { code?: string; name?: string; department_id?: string; level_id?: string; semester?: 1 | 2; academic_year?: string }
      }
      student_courses: {
        Row:    StudentCourse
        Insert: { student_id: string; course_id: string }
        Update: { status?: 'active' | 'dropped' }
      }
      session_templates: {
        Row:    SessionTemplate
        Insert: { course_id: string; device_id: string; day_of_week: DayOfWeek; start_time: string; duration_minutes: number; valid_from: string; valid_until: string; is_active?: boolean }
        Update: { day_of_week?: DayOfWeek; start_time?: string; duration_minutes?: number; valid_from?: string; valid_until?: string; is_active?: boolean }
      }
      sessions: {
        Row:    Session
        Insert: SessionInsert
        Update: SessionUpdate
      }
      attendance_records: {
        Row:    AttendanceRecord
        Insert: never
        Update: never
      }
    }
    Enums: {
      enrollment_status: EnrollmentStatus
      attendance_status: AttendanceStatus
      sync_type:         SyncType
      day_of_week:       DayOfWeek
    }
  }
}