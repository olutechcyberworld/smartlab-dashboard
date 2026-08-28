/**
 * backend.ts
 *
 * The four operations that require an active MQTT connection to the lab device
 * are routed through the Node.js backend service. Every other data operation
 * in the dashboard goes directly to Supabase.
 *
 * These four functions are the complete boundary between the two systems.
 */

const BASE_URL = import.meta.env.VITE_BACKEND_URL as string

if (!BASE_URL) {
  throw new Error('VITE_BACKEND_URL must be set in .env.local')
}

async function post<TBody, TResponse>(
  path: string,
  body: TBody
): Promise<TResponse> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }))
    throw new Error(
      (error as { message?: string }).message ?? `Backend request failed: ${path}`
    )
  }

  return response.json() as Promise<TResponse>
}

// ─── 1. Send fingerprint enrollment command to device ─────────────────────────

export interface EnrollmentCommandPayload {
  studentId: string
  deviceId:  string
}

export interface EnrollmentCommandResult {
  commandId:  string
  dispatched: boolean
}

export function sendEnrollmentCommand(
  payload: EnrollmentCommandPayload
): Promise<EnrollmentCommandResult> {
  return post<EnrollmentCommandPayload, EnrollmentCommandResult>(
    '/api/enrollment/command',
    payload
  )
}

// ─── 2. Send fingerprint deletion command to device ───────────────────────────

export interface EnrollmentDeletePayload {
  studentId:          string
  deviceId:           string
  fingerprintSlotId:  number
}

export interface EnrollmentDeleteResult {
  commandId:  string
  dispatched: boolean
}

export function sendEnrollmentDelete(
  payload: EnrollmentDeletePayload
): Promise<EnrollmentDeleteResult> {
  return post<EnrollmentDeletePayload, EnrollmentDeleteResult>(
    '/api/enrollment/delete',
    payload
  )
}

// ─── 3. Push session schedule to device ──────────────────────────────────────

export interface SessionSyncResult {
  pushed: number
}

export function pushSessionSchedule(deviceId: string): Promise<SessionSyncResult> {
  return post<Record<string, never>, SessionSyncResult>(
    `/api/devices/${deviceId}/sessions/sync`,
    {}
  )
}


// // ─── 4. Flush BTN2 manual session queue ──────────────────────────────────────

// export interface FlushResult {
//   flushed:   boolean
//   timestamp: string
// }

// export function flushManualSession(deviceId: string): Promise<FlushResult> {
//   return post<Record<string, never>, FlushResult>(
//     `/api/devices/${deviceId}/flush`,
//     {}
//   )
// }