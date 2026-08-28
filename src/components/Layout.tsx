import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  Fingerprint,
  ClipboardList,
  Users,
  CalendarDays,
  MonitorDot,
  LogOut,
} from 'lucide-react'
import { cn }       from '@/lib/utils'
import { useAuth }  from '@/hooks/useAuth'

const NAV_ITEMS = [
  { to: '/attendance', label: 'Attendance', icon: ClipboardList },
  { to: '/students',   label: 'Students',   icon: Users },
  { to: '/sessions',   label: 'Sessions',   icon: CalendarDays },
  { to: '/devices',    label: 'Devices',    icon: MonitorDot },
] as const

export function Layout() {
  const { user, signOut } = useAuth()
  const navigate          = useNavigate()

  async function handleSignOut() {
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex h-screen w-full overflow-hidden">

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="flex w-60 flex-shrink-0 flex-col bg-sidebar border-r border-sidebar-border">

        {/* Logo mark */}
        <div className="flex h-16 items-center gap-3 px-5 border-b border-sidebar-border">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/25">
            <Fingerprint className="h-4 w-4 text-primary" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-sidebar-accent-foreground leading-none truncate">
              Smart Lab
            </p>
            <p className="text-xs text-sidebar-foreground/60 mt-1 leading-none truncate">
              Attendance System
            </p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-4 px-3">
          <ul className="flex flex-col gap-1">
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  className={({ isActive }) =>
                    cn(
                      'group flex items-center gap-3 rounded-md py-2.5 text-sm transition-colors duration-100',
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium pl-[10px] pr-3 border-l-2 border-primary'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground pl-3 pr-3'
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon
                        className={cn(
                          'h-4 w-4 flex-shrink-0 transition-colors',
                          isActive
                            ? 'text-primary'
                            : 'text-sidebar-foreground/70 group-hover:text-sidebar-foreground'
                        )}
                        strokeWidth={1.5}
                      />
                      {label}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        {/* User / sign out */}
        <div className="border-t border-sidebar-border p-3">
          <div className="px-3 py-2 mb-1">
            <p className="text-xs text-sidebar-foreground/50 uppercase tracking-wide leading-none mb-1">
              Signed in as
            </p>
            <p className="text-sm text-sidebar-foreground truncate">
              {user?.email ?? '—'}
            </p>
          </div>
          <button
            onClick={handleSignOut}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground transition-colors duration-100"
          >
            <LogOut className="h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
            Sign out
          </button>
        </div>

      </aside>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <main className="flex flex-1 flex-col overflow-hidden bg-background">
        <Outlet />
      </main>

    </div>
  )
}