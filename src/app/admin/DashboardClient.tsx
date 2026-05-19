'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import { isNative } from '@/lib/native-bridge'
import { NotificationOnboarding } from '@/components/NotificationOnboarding'
import { IosInstallBanner } from '@/components/IosInstallBanner'
import ManualSyncButton from '@/components/ManualSyncButton'

interface DashboardProps {
  stats: {
    totalProjects: number
    activeProjects: number
    pendingProjects: number
    completedProjects: number
    leadProjects: number
    totalOperators: number
    totalBudget: number
    totalSpent: number
    totalHours7d: number
    totalMessages7d: number
    totalExpenses7d: number
  }
  recentExpenses: {
    id: number
    amount: number
    description: string | null
    date: string
    projectTitle: string
    userName: string
  }[]
  recentMessages: {
    id: number
    content: string | null
    type: string
    createdAt: string
    projectTitle: string
    userName: string
    phaseTitle: string | null
  }[]
  activeProjects: {
    id: number
    title: string
    type: string
    status: string
    clientName: string
    phasesTotal: number
    phasesCompleted: number
    teamMembers: string[]
    expenseCount: number
    estimatedBudget: number
    realCost: number
    estimatedDays: number
    startDate?: string
    phases: { id: number; title: string; status: string; estimatedDays: number }[]
  }[]
  teamList: {
    id: number
    name: string
    role: string
    phone: string | null
    projectCount: number
  }[]
}

const typeLabels: Record<string, string> = {
  PISCINA: '🏊 Piscina',
  RIEGO: '🌱 Riego',
  SPA: '💧 Spa',
  MANTENIMIENTO: '🔧 Mantenimiento',
  PILETA: '⛲ Pileta',
  TURCO: '♨️ Turco',
  POTABILIZACION: '💦 Potabilización',
  CONTRA_INCENDIOS: '🔥 Contra incendios',
  OTRO: '📋 Otro',
}

const statusBadge: Record<string, { className: string; label: string }> = {
  LEAD: { className: 'badge badge-info badge-dot', label: 'Lead' },
  ACTIVO: { className: 'badge badge-success badge-dot', label: 'Activo' },
  PENDIENTE: { className: 'badge badge-warning badge-dot', label: 'Pendiente' },
  COMPLETADO: { className: 'badge badge-neutral badge-dot', label: 'Completado' },
  CANCELADO: { className: 'badge badge-danger badge-dot', label: 'Cancelado' },
  ARCHIVADO: { className: 'badge badge-neutral badge-dot', label: 'Archivado' },
}

const msgTypeIcons: Record<string, string> = {
  TEXT: '💬',
  IMAGE: '📷',
  VIDEO: '🎥',
  AUDIO: '🎙️',
  NOTE: '📝',
  EXPENSE_LOG: '💰',
  DAY_START: '🌅',
  DAY_END: '🌙',
  PHASE_COMPLETE: '✅',
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(n)
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `hace ${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `hace ${hrs}h`
  const days = Math.floor(hrs / 24)
  return `hace ${days}d`
}

import { db } from '@/lib/db'

export default function DashboardClient({ 
  stats: initialStats, 
  recentExpenses: initialExpenses, 
  recentMessages: initialMessages, 
  activeProjects: initialProjects, 
  teamList: initialTeam 
}: DashboardProps) {
  const [stats, setStats] = useState(initialStats)
  const [recentExpenses, setRecentExpenses] = useState(initialExpenses)
  const [recentMessages, setRecentMessages] = useState(initialMessages)
  const [activeProjects, setActiveProjects] = useState(initialProjects)
  const [teamList, setTeamList] = useState(initialTeam)

  const [activeTab, setActiveTab] = useState(0)
  const [mounted, setMounted] = useState(false)
  
  // 1. Initialize activeTab when projects load
  useEffect(() => {
    if (activeProjects.length > 0 && activeTab === 0) {
      setActiveTab(activeProjects[0].id)
    }
  }, [activeProjects, activeTab])

  // 2. Load/Save Offline Cache (Stale-While-Revalidate pattern)
  useEffect(() => {
    async function handleCache() {
      // ALWAYS try to load from cache first for instant UI paint
      const cached = await db.dashboardCache.get('main')
      if (cached) {
        setStats(cached.stats)
        setRecentExpenses(cached.recentExpenses)
        setRecentMessages(cached.recentMessages)
        setActiveProjects(cached.activeProjects)
        setTeamList(cached.teamList)
      }

      // If we have fresh data from props (server fetch succeeded), overwrite state and update cache
      if (initialProjects && initialProjects.length > 0) {
        setStats(initialStats)
        setRecentExpenses(initialExpenses)
        setRecentMessages(initialMessages)
        setActiveProjects(initialProjects)
        setTeamList(initialTeam)

        const dashboardData = {
          id: 'main',
          stats: initialStats,
          recentExpenses: initialExpenses,
          recentMessages: initialMessages,
          activeProjects: initialProjects,
          teamList: initialTeam,
          timestamp: Date.now()
        }
        await db.dashboardCache.put(dashboardData)
      } 
    }
    handleCache()
  }, [initialStats, initialExpenses, initialMessages, initialProjects, initialTeam])

  const [pushDismissed, setPushDismissed] = useState(true)
  const { 
    status: pushStatus, 
    subscribe: pushSubscribe, 
    isSubscribing,
    showOnboarding,
    setShowOnboarding 
  } = usePushNotifications()

  useEffect(() => {
    setMounted(true)
    const dismissed = localStorage.getItem('push_dismissed')
    if (dismissed) {
      const dismissedAt = Number(dismissed)
      // Show again after 7 days
      if (Date.now() - dismissedAt > 7 * 24 * 60 * 60 * 1000) {
        setPushDismissed(false)
      }
    } else {
      setPushDismissed(false)
    }
  }, [])

  const budgetPercent = stats.totalBudget > 0 ? Math.min((stats.totalSpent / stats.totalBudget) * 100, 100) : 0

  const selectedProject = activeProjects.find(p => p.id === activeTab) || activeProjects[0]

  // Calculate days for selected project
  let realDays = 0
  if (selectedProject?.startDate) {
    const start = new Date(selectedProject.startDate)
    const now = new Date()
    realDays = Math.max(0, Math.ceil((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)))
  }

  const budgetProgress = selectedProject?.estimatedBudget > 0 
    ? (selectedProject.realCost / selectedProject.estimatedBudget) * 100 
    : 0
  
  const daysProgress = selectedProject?.estimatedDays > 0
    ? (realDays / selectedProject.estimatedDays) * 100
    : 0

  const getBarColor = (percent: number) => {
    if (percent > 100) return 'danger'
    if (percent > 85) return 'warning'
    return 'success'
  }

  return (
    <div className="animate-fade-in">
      {/* Page Header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Resumen general de Aquatech</p>
        </div>
        <ManualSyncButton />
      </div>

      {/* iOS Install Guide (Only if needed) */}
      <IosInstallBanner />

      {/* Notification Onboarding Modal */}
      {showOnboarding && (
        <NotificationOnboarding onDone={() => setShowOnboarding(false)} />
      )}

      {/* Push Notification Banner for Admins */}
      {pushStatus !== 'subscribed' && pushStatus !== 'loading' && !pushDismissed && (
        <div style={{
          background: pushStatus === 'denied' || pushStatus === 'unsupported' 
            ? 'rgba(255,255,255,0.05)' 
            : 'linear-gradient(135deg, #0070c0, #38bdf8)',
          borderRadius: '16px',
          padding: '16px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '15px',
          flexWrap: 'wrap',
          margin: '0 0 25px 0',
          boxShadow: pushStatus === 'denied' ? 'none' : '0 4px 20px rgba(0, 112, 192, 0.2)',
          border: pushStatus === 'denied' ? '1px solid rgba(255,255,255,0.1)' : 'none',
          position: 'relative',
          animation: 'fade-in 0.5s ease-out',
          overflow: 'hidden'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: '200px' }}>
            <span style={{ fontSize: '1.8rem' }}>{pushStatus === 'denied' ? '🚫' : pushStatus === 'unsupported' ? '📱' : '🔔'}</span>
            <div>
              <p style={{ margin: 0, color: 'white', fontWeight: 'bold', fontSize: '0.95rem' }}>
                {pushStatus === 'denied' 
                  ? 'Notificaciones Bloqueadas' 
                  : pushStatus === 'unsupported'
                  ? 'Notificaciones no soportadas'
                  : isNative()
                  ? 'Notificaciones en la App'
                  : 'Activa las Notificaciones de Administrador'}
              </p>
              <p style={{ margin: 0, color: 'rgba(255,255,255,0.85)', fontSize: '0.8rem' }}>
                {pushStatus === 'denied'
                  ? 'Debes habilitar los permisos en los ajustes de tu celular o navegador.'
                  : pushStatus === 'unsupported'
                  ? (/iPad|iPhone|iPod/.test(navigator.userAgent) 
                    ? 'Tu iPhone (sin instalar) no permite avisos push.' 
                    : 'Tu navegador o dispositivo no admite avisos push.')
                  : isNative()
                  ? 'Recibe alertas nativas en tiempo real de tus proyectos y chats.'
                  : 'Recibe alertas en tiempo real de proyectos y mensajes'}
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', zIndex: 5 }}>
            {(pushStatus === 'denied' || pushStatus === 'unsupported' || (!isNative() && /android|iphone|ipad/i.test(navigator.userAgent))) && (
              <button
                onClick={() => setShowOnboarding(true)}
                style={{
                  backgroundColor: 'rgba(255,255,255,0.1)',
                  color: 'white',
                  fontWeight: '600',
                  padding: '10px 15px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.2)',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  touchAction: 'manipulation'
                }}
              >
                Ayuda
              </button>
            )}
            
            {pushStatus === 'prompt' || pushStatus === 'unsubscribed' ? (
              <button
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const result = await pushSubscribe()
                  if (result.success) {
                    setPushDismissed(true)
                  } else {
                    alert(result.error || 'No se pudo activar. Asegúrate de tener internet. En iPhone, instala la app primero.')
                  }
                }}
                disabled={isSubscribing}
                style={{
                  backgroundColor: 'white',
                  color: '#0070c0',
                  fontWeight: 'bold',
                  padding: '12px 24px',
                  borderRadius: '12px',
                  border: 'none',
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                  touchAction: 'manipulation',
                  opacity: isSubscribing ? 0.7 : 1,
                  transition: 'all 0.2s ease',
                  transform: isSubscribing ? 'scale(0.98)' : 'scale(1)'
                }}
              >
                {isSubscribing ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div className="animate-spin" style={{ width: '12px', height: '12px', border: '2px solid #0070c0', borderTopColor: 'transparent', borderRadius: '50%' }}></div>
                    <span>...</span>
                  </div>
                ) : 'Activar'}
              </button>
            ) : null}

            <button 
              onClick={() => {
                localStorage.setItem('push_dismissed', Date.now().toString())
                setPushDismissed(true)
              }}
              style={{ 
                background: 'rgba(255,255,255,0.1)', 
                border: 'none', 
                color: 'white', 
                cursor: 'pointer', 
                width: '30px',
                height: '30px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1rem' 
              }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="kpi-grid">
        <div className="kpi-card" style={{ '--kpi-color': 'var(--primary)', '--kpi-bg': 'var(--info-bg)' } as React.CSSProperties}>
          <div className="kpi-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/></svg>
          </div>
          <div className="kpi-value">{stats.activeProjects}</div>
          <div className="kpi-label">Proyectos Activos</div>
          <div className="kpi-trend up">de {stats.totalProjects} totales</div>
        </div>

        <div className="kpi-card" style={{ '--kpi-color': 'var(--warning)', '--kpi-bg': 'var(--warning-bg)' } as React.CSSProperties}>
          <div className="kpi-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div className="kpi-value">{stats.leadProjects}</div>
          <div className="kpi-label">Leads / Prospectos</div>
          <div className="kpi-trend up">{stats.pendingProjects} pendientes</div>
        </div>

        <div className="kpi-card" style={{ '--kpi-color': 'var(--success)', '--kpi-bg': 'var(--success-bg)' } as React.CSSProperties}>
          <div className="kpi-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div className="kpi-value">{stats.totalOperators}</div>
          <div className="kpi-label">Operarios Activos</div>
        </div>
      </div>

      {/* ACCIONES RÁPIDAS */}
      <div style={{ marginBottom: '30px' }}>
        <h3 style={{ marginBottom: '15px', color: 'var(--text-muted)', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
          ⚡ Acciones Rápidas
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '15px' }}>
          <Link href="/admin/cotizaciones/nuevo" className="card-sub interactive" style={{ padding: '15px', display: 'flex', alignItems: 'center', gap: '12px', textDecoration: 'none' }}>
            <div style={{ background: 'var(--primary-bg)', color: 'var(--primary)', padding: '10px', borderRadius: '10px' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M12 18v-6M9 15h6"/></svg>
            </div>
            <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text)' }}>Nueva Cotización</div>
          </Link>
          
          <Link href="/admin/proyectos/nuevo" className="card-sub interactive" style={{ padding: '15px', display: 'flex', alignItems: 'center', gap: '12px', textDecoration: 'none' }}>
            <div style={{ background: 'var(--success-bg)', color: 'var(--success)', padding: '10px', borderRadius: '10px' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M12 11V7M9 9h6"/></svg>
            </div>
            <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text)' }}>Nuevo Proyecto</div>
          </Link>

          <Link href="/admin/calendario" className="card-sub interactive" style={{ padding: '15px', display: 'flex', alignItems: 'center', gap: '12px', textDecoration: 'none' }}>
            <div style={{ background: 'var(--warning-bg)', color: 'var(--warning)', padding: '10px', borderRadius: '10px' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            </div>
            <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text)' }}>Ver Calendario</div>
          </Link>

          <Link href="/admin/inventario" className="card-sub interactive" style={{ padding: '15px', display: 'flex', alignItems: 'center', gap: '12px', textDecoration: 'none' }}>
            <div style={{ background: 'var(--info-bg)', color: 'var(--info)', padding: '10px', borderRadius: '10px' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
            </div>
            <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text)' }}>Inventario</div>
          </Link>
        </div>
      </div>

      {/* Weekly Intelligence (New Section) */}
      <h3 style={{ marginBottom: '15px', color: 'var(--text-muted)', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
        📈 Desempeño Semanal (Últimos 7 días)
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '15px', marginBottom: '30px' }}>
        <div className="card-sub" style={{ padding: '15px', background: 'var(--bg-surface)', border: '1px solid var(--primary-light)', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '15px' }}>
           <div style={{ fontSize: '1.5rem' }}>⏱️</div>
           <div>
             <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Horas Totales del Equipo</div>
             <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--primary)' }}>{stats.totalHours7d} hrs</div>
           </div>
        </div>
        <div className="card-sub" style={{ padding: '15px', background: 'var(--bg-surface)', border: '1px solid var(--info)', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '15px' }}>
           <div style={{ fontSize: '1.5rem' }}>📸</div>
           <div>
             <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Reportes en Chat</div>
             <div style={{ fontSize: '1.25rem', fontWeight: 800 }}>{stats.totalMessages7d}</div>
           </div>
        </div>
        <div className="card-sub" style={{ padding: '15px', background: 'var(--bg-surface)', border: '1px solid var(--danger-light)', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '15px' }}>
           <div style={{ fontSize: '1.5rem' }}>💸</div>
           <div>
             <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Gasto Semanal (Viáticos)</div>
             <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--danger)' }}>{formatCurrency(stats.totalExpenses7d)}</div>
           </div>
        </div>
      </div>


      {/* Comparison Tabs */}
      {activeProjects.length > 0 && (
        <div className="card mb-lg" style={{ border: '1px solid var(--primary-glow)' }}>
          <div className="card-header">
            <div>
              <div className="card-title">Estado de Proyectos Activos (Top 5)</div>
              <div className="card-subtitle">Comparativa Real vs Teórica en Tiempo y Gastos</div>
            </div>
          </div>

          {/* Project Tabs */}
          <div style={{ 
            display: 'flex', 
            gap: '8px', 
            marginBottom: '25px', 
            overflowX: 'auto', 
            paddingBottom: '8px',
            borderBottom: '1px solid var(--border)' 
          }}>
            {activeProjects.map(p => (
              <button
                key={p.id}
                onClick={() => setActiveTab(p.id)}
                className={`btn ${activeTab === p.id ? 'btn-primary' : 'btn-ghost'}`}
                style={{ 
                  whiteSpace: 'nowrap', 
                  fontSize: '0.85rem',
                  padding: '8px 16px',
                  opacity: activeTab === p.id ? 1 : 0.6
                }}
              >
                {p.title.length > 15 ? p.title.substring(0, 15) + '...' : p.title}
              </button>
            ))}
          </div>

          {selectedProject && (
            <div className="animate-fade-in" key={selectedProject.id}>
              {/* Twin Bars Layout */}
              <div className="grid-responsive" style={{ gap: '20px' }}>
                
                {/* 1. Comparison Budget */}
                <div className="comparison-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>📊 Comparativa de Presupuesto</span>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{budgetProgress.toFixed(0)}% Utilizado</span>
                  </div>
                  
                  <div className="twin-bars-container" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {/* Bar Real */}
                    <div style={{ position: 'relative' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '4px' }}>
                        <span style={{ color: 'var(--text-muted)' }}>Gasto Real</span>
                        <span style={{ fontWeight: 'bold' }}>{formatCurrency(selectedProject.realCost)}</span>
                      </div>
                      <div className="progress-bar" style={{ height: '24px', backgroundColor: 'rgba(255,255,255,0.05)' }}>
                        <div 
                          className={`progress-fill ${getBarColor(budgetProgress)}`} 
                          style={{ width: `${Math.min(budgetProgress, 100)}%`, transition: 'width 1s ease-out' }} 
                        />
                      </div>
                    </div>
                    
                    {/* Bar Teórica */}
                    <div style={{ position: 'relative' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '4px' }}>
                        <span style={{ color: 'var(--text-muted)' }}>Prespuesto Teórico (Referencial)</span>
                        <span style={{ fontWeight: 'bold', color: 'var(--primary)' }}>{formatCurrency(selectedProject.estimatedBudget)}</span>
                      </div>
                      <div className="progress-bar" style={{ height: '8px', opacity: 0.3 }}>
                        <div className="progress-fill" style={{ width: '100%', backgroundColor: 'var(--primary)' }} />
                      </div>
                    </div>
                  </div>
                </div>

                {/* 2. Comparison Time */}
                <div className="comparison-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>⏱️ Comparativa de Tiempo</span>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{daysProgress.toFixed(0)}% del Plazo</span>
                  </div>

                  <div className="twin-bars-container" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {/* Bar Real */}
                    <div style={{ position: 'relative' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '4px' }}>
                        <span style={{ color: 'var(--text-muted)' }}>Días Transcurridos</span>
                        <span style={{ fontWeight: 'bold' }}>{realDays} días</span>
                      </div>
                      <div className="progress-bar" style={{ height: '24px', backgroundColor: 'rgba(255,255,255,0.05)' }}>
                        <div 
                          className={`progress-fill ${getBarColor(daysProgress)}`} 
                          style={{ width: `${Math.min(daysProgress, 100)}%`, transition: 'width 1s ease-out' }} 
                        />
                      </div>
                    </div>

                    {/* Bar Teórica */}
                    <div style={{ position: 'relative' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '4px' }}>
                        <span style={{ color: 'var(--text-muted)' }}>Plazo Estimado (Contrato)</span>
                        <span style={{ fontWeight: 'bold', color: 'var(--success)' }}>{selectedProject.estimatedDays} días</span>
                      </div>
                      <div className="progress-bar" style={{ height: '8px', opacity: 0.3 }}>
                        <div className="progress-fill" style={{ width: '100%', backgroundColor: 'var(--success)' }} />
                      </div>
                    </div>
                  </div>
                </div>

              </div>

              {/* Warnings */}
              <div style={{ marginTop: '20px', display: 'flex', gap: '15px' }}>
                 {budgetProgress > 100 && (
                   <div style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger)', padding: '10px 15px', borderRadius: '8px', flex: 1, display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.85rem', color: 'var(--danger)' }}>
                     <strong>⚠️ Alerta Presupuesto:</strong> El gasto real ha superado el presupuesto teórico por {formatCurrency(selectedProject.realCost - selectedProject.estimatedBudget)}.
                   </div>
                 )}
                 {daysProgress > 100 && (
                   <div style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning)', padding: '10px 15px', borderRadius: '8px', flex: 1, display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.85rem', color: 'var(--warning)' }}>
                     <strong>🕒 Alerta Cronograma:</strong> El proyecto ha superado el tiempo estimado inicial.
                   </div>
                 )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Team Section */}
      <div className="card mb-lg">
        <div className="card-header">
          <div>
            <div className="card-title">Equipo de Trabajo</div>
            <div className="card-subtitle">Administradores y Operadores activos</div>
          </div>
          <Link href="/admin/team" className="btn btn-ghost btn-sm">Gestionar Equipo →</Link>
        </div>
        
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', 
          gap: 'var(--space-md)',
          marginTop: 'var(--space-md)' 
        }}>
          {teamList.map(u => (
            <div key={u.id} className="card-sub" style={{ 
              padding: '15px', 
              background: 'var(--bg-surface)', 
              borderRadius: '12px',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ 
                  fontSize: '0.65rem', 
                  fontWeight: 800, 
                  padding: '2px 8px', 
                  borderRadius: '6px',
                  background: u.role === 'ADMIN' ? 'var(--success-bg)' : 'var(--primary-bg)',
                  color: u.role === 'ADMIN' ? 'var(--success)' : 'var(--primary)',
                  letterSpacing: '1px'
                }}>
                  {u.role}
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  {u.projectCount} proyectos
                </span>
              </div>
              
              <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text)' }}>
                {u.name}
              </div>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                {u.phone || 'Sin teléfono'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Two columns: Projects + Activity */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-md)' }} className="dashboard-grid">
        {/* Active Projects */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">Proyectos Recientes</div>
            <Link href="/admin/proyectos" className="btn btn-ghost btn-sm">Ver todos →</Link>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
            {activeProjects.map((p) => {
              const progress = p.phasesTotal > 0 ? (p.phasesCompleted / p.phasesTotal) * 100 : 0
              return (
                <Link key={p.id} href={`/admin/proyectos/${p.id}`} style={{ textDecoration: 'none' }}>
                  <div style={{ padding: 'var(--space-md)', background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)', transition: 'all var(--transition-fast)', cursor: 'pointer', border: '1px solid var(--border)' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-hover)' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)' }}
                  >
                    <div className="flex justify-between items-center" style={{ marginBottom: '8px' }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text)' }}>{p.title}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{typeLabels[p.type] || p.type} · {p.clientName}</div>
                      </div>
                      <span className={statusBadge[p.status]?.className}>{statusBadge[p.status]?.label}</span>
                    </div>
                    {p.phasesTotal > 0 && (
                      <div>
                        <div className="flex justify-between" style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                          <span>Fases: {p.phasesCompleted}/{p.phasesTotal}</span>
                          <span>{progress.toFixed(0)}%</span>
                        </div>
                        <div className="progress-bar">
                          <div className="progress-fill" style={{ width: `${progress}%` }} />
                        </div>
                      </div>
                    )}
                    {p.teamMembers.length > 0 && (
                      <div style={{ display: 'flex', gap: '4px', marginTop: '8px', flexWrap: 'wrap' }}>
                        {p.teamMembers.map((name, i) => (
                          <span key={i} style={{ fontSize: '0.65rem', background: 'var(--primary-glow)', color: 'var(--primary)', padding: '2px 8px', borderRadius: 'var(--radius-full)' }}>
                            {name.split(' ')[0]}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </Link>
              )
            })}
            {activeProjects.length === 0 && (
              <div className="empty-state">
                <p className="empty-state-text">No hay proyectos activos</p>
              </div>
            )}
          </div>
        </div>

        {/* Activity Feed */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">Actividad Reciente</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {/* Messages */}
            {recentMessages.map((msg) => (
              <div key={`msg-${msg.id}`} style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', fontSize: '0.82rem', borderBottom: '1px solid var(--border)' }}>
                <div className="flex items-center gap-sm" style={{ marginBottom: '2px' }}>
                  <span>{msgTypeIcons[msg.type] || '💬'}</span>
                  <strong style={{ color: 'var(--text)' }}>{msg.userName}</strong>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                    {mounted ? timeAgo(msg.createdAt) : '...'}
                  </span>
                </div>
                <div style={{ color: 'var(--text-secondary)', paddingLeft: '26px', fontSize: '0.78rem' }}>
                  {msg.content?.slice(0, 80)}{(msg.content?.length || 0) > 80 ? '...' : ''}
                </div>
                <div style={{ paddingLeft: '26px', fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {msg.projectTitle}{msg.phaseTitle ? ` · ${msg.phaseTitle}` : ''}
                </div>
              </div>
            ))}

            {/* Recent Expenses */}
            {recentExpenses.length > 0 && (
              <>
                <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', padding: '12px 12px 4px', marginTop: '8px' }}>
                  Gastos Recientes
                </div>
                {recentExpenses.slice(0, 3).map((exp) => (
                  <div key={`exp-${exp.id}`} style={{ padding: '8px 12px', fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
                    <div>
                      <div style={{ color: 'var(--text)' }}>{exp.description}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{exp.projectTitle} · {exp.userName}</div>
                    </div>
                    <span style={{ fontFamily: 'var(--font-brand)', fontWeight: 700, color: 'var(--danger)' }}>{formatCurrency(exp.amount)}</span>
                  </div>
                ))}
              </>
            )}

            {recentMessages.length === 0 && recentExpenses.length === 0 && (
              <div className="empty-state">
                <p className="empty-state-text">Sin actividad reciente</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @media (max-width: 768px) {
          .dashboard-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  )
}
