import { useQuery, useMutation }                    from '@tanstack/react-query'
import { formatDistanceToNow }                      from 'date-fns'
import type { LucideIcon }                          from 'lucide-react'
import {
  RefreshCw, Send,
  Wifi, WifiOff, Clock, MapPin, Cpu, Globe,
} from 'lucide-react'
import { toast }    from 'sonner'
import { cn }       from '@/lib/utils'
import { supabase } from '@/lib/supabase'
import { pushSessionSchedule } from '@/lib/backend'
import { Button }   from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { Device } from '@/types/database'

// ─── Safe date parsing ──────────────────────────────────────────────────────
// Guards against null, empty string, or malformed timestamps from the
// backend/EMQX RPC writes (e.g. an LWT payload missing its timestamp field).
function safeDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return isNaN(d.getTime()) ? null : d
}

// ─── Query ────────────────────────────────────────────────────────────────────

async function fetchDevice(): Promise<Device | null> {
  const { data, error } = await supabase
    .from('devices')
    .select('*')
    .eq('is_active', true)
    .order('last_seen', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

// ─── InfoRow ──────────────────────────────────────────────────────────────────

function InfoRow({
  icon: Icon, label, value,
}: {
  icon:  LucideIcon
  label: string
  value: string | null | undefined
}) {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-border last:border-0">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium text-foreground mt-0.5 truncate">
          {value ?? '—'}
        </p>
      </div>
    </div>
  )
}

// ─── ActionRow ────────────────────────────────────────────────────────────────

function ActionRow({
  icon: Icon, label, description, buttonLabel, loading, disabled, onClick,
}: {
  icon:        LucideIcon
  label:       string
  description: string
  buttonLabel: string
  loading:     boolean
  disabled:    boolean
  onClick:     () => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-border last:border-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="gap-2 flex-shrink-0 text-sm"
        disabled={disabled || loading}
        onClick={onClick}
      >
        <Icon className="h-4 w-4" strokeWidth={1.5} />
        {loading ? 'Working…' : buttonLabel}
      </Button>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Devices() {
  const { data: device, isLoading, refetch } = useQuery({
    queryKey:        ['device'],
    queryFn:         fetchDevice,
    refetchInterval: 30_000,
  })

  const pushMutation = useMutation({
    mutationFn: () => {
      if (!device) throw new Error('No device found.')
      return pushSessionSchedule(device.id)
    },
    onSuccess: (result) => {
      toast.success(
        `Schedule pushed — ${result.pushed} ` +
        `${result.pushed === 1 ? 'session' : 'sessions'} delivered to device.`
      )
    },
    onError: (err: Error) => {
      toast.error(err.message ?? 'Failed to push schedule.')
    },
  })

  const isOnline   = device?.status === 'online'
  const lastSeen   = safeDate(device?.last_seen)
  const lastSync   = safeDate(device?.last_session_sync)

  return (
    <div className="flex h-full flex-col overflow-hidden">

      <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-border px-8">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Devices</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Hardware status and sync</p>
        </div>
        <Button
          variant="outline" size="sm" className="gap-2 text-sm"
          onClick={() => refetch()}
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </header>

      <div className="flex-1 overflow-auto p-8">
        {isLoading ? (
          <div className="flex flex-col gap-4 max-w-lg">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-52 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        ) : !device ? (
          <div className="flex h-64 items-center justify-center">
            <div className="text-center">
              <p className="text-base font-medium text-foreground">No device registered</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-xs">
                No active device record found. Insert a device row in the database
                and flash its UUID to the ESP32 firmware.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 max-w-lg">

            {/* Status banner */}
            <div className={cn(
              'rounded-xl border p-5 flex items-center justify-between gap-4',
              isOnline
                ? 'border-green-200 bg-green-50'
                : 'border-border bg-muted/40'
            )}>
              <div className="flex items-center gap-3">
                <div className={cn(
                  'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full',
                  isOnline ? 'bg-green-100' : 'bg-muted'
                )}>
                  {isOnline
                    ? <Wifi    className="h-5 w-5 text-green-700"        strokeWidth={1.5} />
                    : <WifiOff className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
                  }
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-base font-semibold text-foreground">
                      {device.name}
                    </p>
                    {isOnline ? (
                      <span className="flex items-center gap-1.5 text-xs font-medium text-green-700">
                        <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-live-pulse" />
                        Online
                      </span>
                    ) : (
                      <span className="text-xs font-medium text-muted-foreground">
                        Offline
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {device.location}
                  </p>
                </div>
              </div>

              {lastSeen && (
                <div className="text-right flex-shrink-0">
                  <p className="text-xs text-muted-foreground">Last seen</p>
                  <p className="text-sm font-medium text-foreground mt-0.5">
                    {formatDistanceToNow(lastSeen, { addSuffix: true })}
                  </p>
                </div>
              )}
            </div>

            {/* Device details */}
            <div className="rounded-xl border border-border bg-card p-5">
              <p className="text-sm font-semibold text-foreground mb-2">Device details</p>
              <InfoRow icon={Cpu}   label="Firmware version" value={device.firmware_version} />
              <InfoRow icon={Globe} label="IP address"       value={device.ip_address} />
              <InfoRow
                icon={Clock}
                label="Last session sync"
                value={lastSync ? formatDistanceToNow(lastSync, { addSuffix: true }) : null}
              />
              <InfoRow icon={MapPin} label="MQTT client ID" value={device.mqtt_client_id} />
            </div>

            {/* Actions */}
            <div className="rounded-xl border border-border bg-card p-5">
              <p className="text-sm font-semibold text-foreground mb-0.5">Actions</p>
              <p className="text-xs text-muted-foreground mb-4">
                Requires the device to be online and connected to the MQTT broker.
              </p>
              <ActionRow
                icon={Send}
                label="Push session schedule"
                description="Delivers upcoming sessions to the device SD card cache over MQTT."
                buttonLabel="Push schedule"
                loading={pushMutation.isPending}
                disabled={!isOnline}
                onClick={() => pushMutation.mutate()}
              />
            </div>

          </div>
        )}
      </div>

    </div>
  )
}