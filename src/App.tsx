import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider }        from '@tanstack/react-query'
import { ReactQueryDevtools }                      from '@tanstack/react-query-devtools'
import { Toaster }         from '@/components/ui/sonner'
import { AuthProvider }    from '@/context/AuthContext'
import { ProtectedRoute }  from '@/components/ProtectedRoute'
import { Layout }          from '@/components/Layout'
import Login               from '@/pages/Login'
import Attendance          from '@/pages/Attendance'
import Students            from '@/pages/Students'
import Courses             from '@/pages/Courses'
import Sessions            from '@/pages/Sessions'
import Devices             from '@/pages/Devices'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime:            60 * 1000,
      gcTime:               5 * 60 * 1000,
      retry:                1,
      refetchOnWindowFocus: false,
    },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>

            <Route path="/login" element={<Login />} />

            <Route element={<ProtectedRoute />}>
              <Route element={<Layout />}>
                <Route index                element={<Navigate to="/attendance" replace />} />
                <Route path="/attendance"   element={<Attendance />} />
                <Route path="/students"     element={<Students />} />
                <Route path="/courses"      element={<Courses />} />
                <Route path="/sessions"     element={<Sessions />} />
                <Route path="/devices"      element={<Devices />} />
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />

          </Routes>
          <Toaster position="top-right" richColors />
        </AuthProvider>
      </BrowserRouter>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  )
}