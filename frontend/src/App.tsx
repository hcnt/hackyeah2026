import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type Health = { status: string; env: string }

async function fetchHealth(): Promise<Health> {
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)

  const check = () =>
    fetchHealth().then(
      (h) => {
        setHealth(h)
        setError(null)
      },
      (e: unknown) => {
        setHealth(null)
        setError(e instanceof Error ? e.message : String(e))
      },
    )

  useEffect(() => {
    void check()
  }, [])

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>hackyeah2026</CardTitle>
          <CardDescription>FastAPI + React + Tailwind + shadcn behind Caddy</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm">
            API:{' '}
            {health ? (
              <span className="font-medium text-green-600">
                {health.status} ({health.env})
              </span>
            ) : error ? (
              <span className="font-medium text-red-600">{error}</span>
            ) : (
              <span className="text-muted-foreground">checking…</span>
            )}
          </p>
          <Button onClick={check}>Check again</Button>
        </CardContent>
      </Card>
    </main>
  )
}
