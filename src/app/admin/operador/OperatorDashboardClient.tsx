'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { getLocalNow, formatToEcuador } from '@/lib/date-utils'
import { db } from '@/lib/db'
import { useLiveQuery } from 'dexie-react-hooks'
import Link from 'next/link'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import { isNative } from '@/lib/native-bridge'
import { hasModuleAccess } from '@/lib/rbac'
import dynamic from 'next/dynamic'

// Fase 3: Dynamic imports — these components are NOT needed for first paint
// AppointmentModal: only opens on user action (~15KB)
// NotificationOnboarding: dismissible banner (~5KB)
// IosInstallBanner: iOS-only popup (~3KB)
// ProjectCacheManager: status badge with SW listeners (~14KB)
// ManualSyncButton: small button (~3KB)
const AppointmentModal = dynamic(() => import('@/components/Calendar/AppointmentModal'), { ssr: false })
const NotificationOnboarding = dynamic(() => import('@/components/NotificationOnboarding').then(m => ({ default: m.NotificationOnboarding })), { ssr: false })
const IosInstallBanner = dynamic(() => import('@/components/IosInstallBanner').then(m => ({ default: m.IosInstallBanner })), { ssr: false })
const ProjectCacheManager = dynamic(() => import('@/components/ProjectCacheManager'), { ssr: false })
const ManualSyncButton = dynamic(() => import('@/components/ManualSyncButton'), { ssr: false })
// Inline SVG icons to match project pattern
const svgProps = (size: number, style?: React.CSSProperties, className?: string) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  style: { display: 'inline-block', verticalAlign: 'middle', ...style }, className
})

const Briefcase = ({ size = 24, style, className }: any) => <svg {...svgProps(size, style, className)}><path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/></svg>
const CalendarIcon = ({ size = 24, style, className }: any) => <svg {...svgProps(size, style, className)}><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 2v4"/><path d="M16 2v4"/></svg>
const CheckCircle2 = ({ size = 24, style, className, fill = 'none' }: any) => <svg {...svgProps(size, style, className)} fill={fill}><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
const Clock = ({ size = 24, style, className }: any) => <svg {...svgProps(size, style, className)}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
const ListTodo = ({ size = 24, style, className }: any) => <svg {...svgProps(size, style, className)}><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 10 2 2 4-4"/><path d="M7 16h10"/></svg>
const Plus = ({ size = 24, style, className }: any) => <svg {...svgProps(size, style, className)}><path d="M12 5v14M5 12h14"/></svg>
const MessageCircle = ({ size = 24, style, className }: any) => <svg {...svgProps(size, style, className)}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>

import { useSearchParams } from 'next/navigation'

interface OperatorDashboardClientProps {
  user: any
  activeProjects: any[]
  activeDayRecord: any
  appointments: any[]
  userViews: any[]
}

export default function OperatorDashboardClient({
  user,
  activeProjects: initialProjects,
  activeDayRecord: initialActiveDayRecord,
  appointments: initialAppointments,
  userViews: initialUserViews
}: OperatorDashboardClientProps) {
  const searchParams = useSearchParams()
  const tabParam = searchParams?.get('tab')

  const [activeTab, setActiveTab] = useState<'PROYECTOS' | 'TAREAS' | 'CALENDARIO'>(() => {
    if (tabParam === 'calendario') return 'CALENDARIO'
    if (typeof window !== 'undefined') {
      const saved = sessionStorage.getItem('operator_active_tab')
      if (saved && ['PROYECTOS', 'TAREAS', 'CALENDARIO'].includes(saved)) return saved as any
    }
    return 'PROYECTOS'
  })
  const [syncNotification, setSyncNotification] = useState<{ id: string, title: string } | null>(null)

  useEffect(() => {
    if (tabParam === 'calendario') {
      setActiveTab('CALENDARIO')
    }
  }, [tabParam])

  useEffect(() => {
    sessionStorage.setItem('operator_active_tab', activeTab)
  }, [activeTab])

  // v287: Robust User recovery for offline sessions
  const [localUser, setLocalUser] = useState(user)
  const [isHydratingAuth, setIsHydratingAuth] = useState(true)

  const [appointments, setAppointments] = useState<any[]>(() => {
    // v316: Recuperación síncrona de tareas con localStorage para sobrevivir al cierre de app
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('last_op_tasks_snapshot')
        if (saved) {
          const parsed = JSON.parse(saved)
          if (Array.isArray(parsed) && parsed.length > 0) return parsed
        }
      } catch (e) {}
    }
    return initialAppointments || []
  })
  const [activeDayRecord, setActiveDayRecord] = useState(initialActiveDayRecord)
  const [userViews, setUserViews] = useState(initialUserViews)

  // v287: Robust Data Hydration
  // Removed old loadData block since day-records and userViews are handled differently and throw 401/404 in offline shell.


  useEffect(() => {
    const recoverAuth = async () => {
      if (!user?.id) {
        try {
          const savedAuth = await db.auth.get('last_session')
          if (savedAuth) {
            console.log('[Offline] Recovered user from Dexie:', savedAuth.name)
            setLocalUser(savedAuth)
          }
        } catch (e) {
          console.error('[Offline] Auth recovery failed:', e)
        }
      }
      setIsHydratingAuth(false)
    }
    recoverAuth()
  }, [user?.id])

  // Use Dexie as live source for projects to support offline correctly
  const projectsFromCache = useLiveQuery(
    async () => {
      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine

      // v359: En offline o si estamos en proceso de hidratación, confiar plenamente en la caché.
      // La caché (db.projectsCache) YA viene filtrada por el servidor durante la sincronización.
      // Re-filtrar por userId en el cliente es arriesgado si la sesión no se ha recuperado del todo.
      const allProjects = await db.projectsCache
        .orderBy('lastAccessedAt')
        .reverse()
        .limit(500)
        .toArray()

      if (isOffline) return allProjects

      const uId = user?.id || localUser?.id
      if (!uId) return allProjects // Fallback: show everything we have in cache

      const userId = Number(uId)
      if (isNaN(userId) || userId <= 0) return allProjects

      // v294: Usar comparación flexible y manejar casos donde team es null/undefined
      const filtered = allProjects.filter(p => {
        const isInTeam = p.team?.some((m: any) => Number(m.userId) == userId)
        const isCreator = Number(p.createdBy || p.createdById) == userId
        // v359: Incluir siempre los proyectos con ID temporal 'pending' para que no desaparezcan
        const isPending = p.isPending || String(p.id).startsWith('pending')
        return isInTeam || isCreator || isPending
      })

      return filtered
    },
    [localUser?.id, user?.id]
  )

  // v287: Live Agenda Cache
  const appointmentsFromCache = useLiveQuery(
    async () => {
      const uId = user?.id || localUser?.id
      if (!uId) return undefined
      
      const appts = await db.appointmentsCache
        .where('userId')
        .equals(Number(uId))
        .toArray()
      
      return appts
    },
    [localUser?.id, user?.id] // Removed isHydratingAuth
  )

  // v293: Persistir tareas cuando cambien en la caché (Snapshot para navegación instantánea)
  useEffect(() => {
    if (appointmentsFromCache && appointmentsFromCache.length > 0) {
      setAppointments(appointmentsFromCache)
      try { localStorage.setItem('last_op_tasks_snapshot', JSON.stringify(appointmentsFromCache)) } catch(e) {}
    }
  }, [appointmentsFromCache])

  // v371: Fetch fresh appointments from API when online.
  // The operator dashboard previously relied ONLY on IndexedDB cache (populated by GlobalSyncWorker).
  // But if an admin creates a task for this operator, it won't appear until the next bulk sync (~15 min).
  // This ensures the operator sees tasks created by others immediately.
  useEffect(() => {
    let isMounted = true

    const fetchFreshAppointments = async () => {
      const uId = user?.id || localUser?.id
      if (!uId || typeof navigator === 'undefined' || !navigator.onLine) return

      try {
        const now = new Date()
        const start = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()
        const end = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString()
        
        const res = await fetch(`/api/appointments?userId=${uId}&start=${start}&end=${end}`)
        if (!isMounted) return
        
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data) && data.length > 0) {
            // Update the cache — useLiveQuery will react automatically
            await db.appointmentsCache.bulkPut(data)
          }
        }
      } catch (e) {
        // Silent — stay with cached data
      }
    }

    // Fetch on mount and when user changes
    fetchFreshAppointments()

    // Also listen for sync-success events to refresh
    const handleSyncSuccess = (event: any) => {
      if (event.detail?.type === 'TASK') {
        fetchFreshAppointments()
      }
    }
    window.addEventListener('sync-success' as any, handleSyncSuccess)

    return () => {
      isMounted = false
      window.removeEventListener('sync-success' as any, handleSyncSuccess)
    }
  }, [user?.id, localUser?.id])

  // v292: Emergency Fallback for Offline "DEAD" state
  const [emergencyProjects, setEmergencyProjects] = useState<any[] | undefined>(() => {
    // v316: Usar localStorage en vez de sessionStorage para que el snapshot sobreviva
    // al cierre y reapertura de la app (sessionStorage se borra al cerrar la pestaña)
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('last_op_projects_snapshot')
        if (saved) {
          const parsed = JSON.parse(saved)
          if (Array.isArray(parsed) && parsed.length > 0) return parsed
        }
      } catch (e) {}
    }
    return undefined
  })

  // v480: Function to fetch fresh projects list from server and populate IndexedDB cache
  const refreshProjectsList = async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
    try {
      const res = await fetch('/api/operator/projects')
      if (res.ok) {
        const apiProjects = await res.json()
        if (Array.isArray(apiProjects)) {
          // Sync Dexie Cache
          for (const proj of apiProjects) {
            const existing = await db.projectsCache.get(Number(proj.id))
            await db.projectsCache.put({
              ...existing,
              ...proj,
              id: Number(proj.id),
              lastAccessedAt: existing?.lastAccessedAt || Date.now()
            })
          }
          // Sync emergency snapshot state
          setEmergencyProjects(apiProjects)
          try {
            localStorage.setItem('last_op_projects_snapshot', JSON.stringify(apiProjects))
          } catch (e) {}
        }
      }
    } catch (e) {
      console.warn('[refreshProjectsList] Failed to refresh:', e)
    }
  }

  useEffect(() => {
    // v400: Added AbortController to prevent multiple concurrent emergency fetches
    // from racing each other when projectsFromCache updates multiple times on mount.
    let isMounted = true;
    const controller = new AbortController();

    const timer = setTimeout(async () => {
      // v480: Keep local Dexie cached projects synced on mount
      
      try {
        const uId = user?.id || localUser?.id
        if (!uId) return
        
        const isOnline = typeof navigator !== 'undefined' && navigator.onLine
        if (isOnline) {
          try {
            // v400: No userId param needed — server reads it from session
            const res = await fetch('/api/operator/projects', { 
              signal: controller.signal,
              priority: 'high' as any
            })
            if (!isMounted) return;
            if (res.ok) {
              const apiProjects = await res.json()
              if (Array.isArray(apiProjects) && apiProjects.length > 0) {
                // Only overwrite if API has >= projects than our local snapshot
                const currentSaved = localStorage.getItem('last_op_projects_snapshot');
                if (currentSaved) {
                  try {
                    const parsed = JSON.parse(currentSaved);
                    if (Array.isArray(parsed) && parsed.length > apiProjects.length) {
                      if (isMounted) setEmergencyProjects(parsed);
                      return;
                    }
                  } catch(e) {}
                }
                if (isMounted) setEmergencyProjects(apiProjects)
                try { localStorage.setItem('last_op_projects_snapshot', JSON.stringify(apiProjects)) } catch(e) {}
                return
              }
            }
          } catch (e: any) {
            if (e?.name === 'AbortError') return; // Intentionally cancelled
            console.warn('[OperatorDashboard] API fetch fallback failed:', e)
          }
        }
        
        const allProjects = await db.projectsCache
          .orderBy('lastAccessedAt').reverse().limit(500).toArray()

        if (!isMounted) return;
        const userId = Number(user?.id || localUser?.id)
        const myProjects = allProjects.filter(p => {
          const isInTeam = p.team?.some((m: any) => Number(m.userId) === userId)
          const isCreator = Number(p.createdBy || p.createdById) === userId
          return isInTeam || isCreator
        })
        
        if (myProjects.length > 0) {
          const currentSaved = localStorage.getItem('last_op_projects_snapshot');
          if (currentSaved) {
            try {
              const parsed = JSON.parse(currentSaved);
              if (Array.isArray(parsed) && parsed.length > myProjects.length) {
                if (isMounted) setEmergencyProjects(parsed);
                return;
              }
            } catch(e) {}
          }
          if (isMounted) setEmergencyProjects(myProjects)
          try { localStorage.setItem('last_op_projects_snapshot', JSON.stringify(myProjects)) } catch(e) {}
        }
      } catch (e) {
        console.error('[EmergencyLoad] Failed:', e)
      }
    }, 400)
    
    return () => {
      isMounted = false;
      controller.abort();
      clearTimeout(timer);
    }
  }, [projectsFromCache, user?.id, localUser?.id])

  // v293/v359: Siempre mantener el snapshot fresco, pero NO sobrescribir con una lista vacía o incompleta
  // si ya tenemos un snapshot más grande guardado.
  useEffect(() => {
    if (projectsFromCache && projectsFromCache.length > 0) {
      try {
        const currentSaved = localStorage.getItem('last_op_projects_snapshot');
        if (currentSaved) {
          const parsed = JSON.parse(currentSaved);
          // v359: Solo sobrescribir si la nueva lista es igual o más grande, o si la actual es muy vieja.
          // Esto evita que al crear 1 proyecto nuevo (offline) borremos los 18 existentes del snapshot.
          if (Array.isArray(parsed) && parsed.length > projectsFromCache.length) {
            // console.log('[Snapshot] Skipping overwrite: current snapshot is larger than live list.');
            return;
          }
        }
        localStorage.setItem('last_op_projects_snapshot', JSON.stringify(projectsFromCache));
      } catch (e) {}
    }
  }, [projectsFromCache])

  // v352: Listen for PROJECT_SYNCED messages from the Service Worker OR sync-success events from GlobalSyncWorker
  useEffect(() => {
    const processSyncedProject = async (projectId: any) => {
      try {
        const cached = await db.projectsCache.get(Number(projectId));
        if (cached) {
          setEmergencyProjects(prev => {
            const existing = (prev || []).filter(p => p.id !== cached.id);
            return [cached, ...existing];
          });
          
          // Show visual notification
          setSyncNotification({ id: String(cached.id), title: cached.title });
          setTimeout(() => setSyncNotification(null), 5000);

          // Persist to snapshot
          try {
            const prevSnap = JSON.parse(localStorage.getItem('last_op_projects_snapshot') || '[]');
            const merged = [cached, ...prevSnap.filter((p: any) => p.id !== cached.id)];
            localStorage.setItem('last_op_projects_snapshot', JSON.stringify(merged.slice(0, 100)));
          } catch (e) {}
        }
      } catch (e) {
        console.warn('[OpDashboard] Sync process error:', e);
      }
    };

    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === 'PROJECT_SYNCED' && event.data?.projectId) {
        processSyncedProject(event.data.projectId);
      }
    };

    const handleSyncSuccess = (event: any) => {
      if (event.detail?.type === 'PROJECT' && event.detail?.projectId) {
        processSyncedProject(event.detail.projectId);
      }
      if (['PROJECT', 'TEAM_UPDATE', 'PROJECT_DELETE'].includes(event.detail?.type)) {
        refreshProjectsList();
      }
    };

    navigator.serviceWorker?.addEventListener('message', handleSwMessage);
    window.addEventListener('sync-success', handleSyncSuccess);
    return () => {
      navigator.serviceWorker?.removeEventListener('message', handleSwMessage);
      window.removeEventListener('sync-success', handleSyncSuccess);
    };
  }, []);

  // v480: Periodically refresh active projects list from server in background every 30s
  useEffect(() => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
    const interval = setInterval(() => {
      refreshProjectsList()
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  // v264: Delayed unread counts to prevent UI blocking on mobile
  const [unreadCounts, setUnreadCounts] = useState<Record<number, number>>({})
  
  useEffect(() => {
    // v274: Highly optimized unread counts (staggered & idle-aware)
    const timer = setTimeout(async () => {
      const userId = Number(user?.id);
      const projectsToProcess = [...(projectsFromCache || [])]
        .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
        .slice(0, 30);

      if (!userId || !projectsToProcess.length) return;

      const counts: Record<number, number> = {};
      
      // Process in small batches of 5 to keep frame rate high
      for (let i = 0; i < projectsToProcess.length; i += 5) {
        const batch = projectsToProcess.slice(i, i + 5);
        
        await db.transaction('r', [db.chatCache], async () => {
          const projectIds = batch.map(p => p.id);
          const chats = await db.chatCache.bulkGet(projectIds);
          
          batch.forEach((p, index) => {
            const chat = chats[index];
            counts[p.id] = p.unreadCount || 0;
            if (chat && chat.messages) {
              const lastSeen = new Date(0);
              counts[p.id] = chat.messages.filter((m: any) => 
                new Date(m.createdAt) > lastSeen && m.userId !== userId
              ).length;
            }
          });
        });

        setUnreadCounts(prev => ({ ...prev, ...counts }));
        
        // v274: Yield to main thread between batches
        if ('requestIdleCallback' in window) {
          await new Promise(resolve => (window as any).requestIdleCallback(resolve, { timeout: 1000 }));
        } else {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }, 8000); // 8s delay to completely clear the LCP path
    return () => clearTimeout(timer);
  }, [projectsFromCache, user?.id]);


  // v291: Search and Pagination
  const [searchTerm, setSearchTerm] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const ITEMS_PER_PAGE = 10

  // v352: Pending offline outbox PROJECT entries (creados sin conexión)
  const pendingProjects = useLiveQuery(
    () => db.outbox.where('type').equals('PROJECT').toArray(),
    []
  ) || []

  // Merge server projects with cache projects (Smart Merge v317)
  const projects = useMemo(() => {
    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;

    // v317: Robust Source Selection (Priority: LiveQuery > Emergency > Server Props)
    const sourceProjects = 
      (projectsFromCache && projectsFromCache.length > 0) ? projectsFromCache :
      (emergencyProjects && emergencyProjects.length > 0) ? emergencyProjects :
      (projectsFromCache === undefined || isHydratingAuth) ? undefined :
      initialProjects;

    // v355: Emergency Merge — If projectsFromCache only has 1 or very few projects 
    // compared to what we know we had (emergencyProjects), merge them.
    // This prevents the "disappearing projects" issue when creating a new one.
    let finalSource = sourceProjects;
    
    // v356: Enhanced merge — if projectsFromCache is suspiciously small, ALWAYS merge with snapshot
    if (Array.isArray(projectsFromCache) && Array.isArray(emergencyProjects) && 
        (projectsFromCache.length < 5 || projectsFromCache.length < (emergencyProjects.length * 0.5))) {
       const map = new Map();
       emergencyProjects.forEach(p => map.set(p.id, p));
       projectsFromCache.forEach(p => map.set(p.id, p));
       finalSource = Array.from(map.values());
    }

    // v317: Si estamos cargando o hidratando auth, NO caer a initialProjects (que es [] offline)
    if (sourceProjects === undefined) {
       return undefined; // Mantiene el estado de carga (spinner)
    }

    // v317: Si estamos offline y el source sigue siendo [], intentar forzar el snapshot de emergencia una vez más
    if (isOffline && sourceProjects.length === 0 && emergencyProjects === undefined) {
       return undefined; // Esperar un ciclo más por el emergency sync
    }

    const projectMap = new Map();
    if (finalSource) {
      finalSource.forEach((p: any) => projectMap.set(p.id, p));
    }

    // v352: Include pending outbox PROJECT entries (creados offline, aún no sincronizados)
    const pendingMapped = pendingProjects.map(p => ({
      ...p.payload,
      id: `pending-${p.id}`,
      isPending: true,
      createdAt: new Date(p.timestamp).toISOString(),
      status: p.payload.status || 'LEAD',
      unreadCount: 0
    }));

    return [
      ...pendingMapped,
      ...Array.from(projectMap.values())
        .filter(p => !pendingMapped.some(pp => pp.title === p.title))
        .map(p => ({
          ...p,
          unreadCount: unreadCounts?.[p.id] ?? p.unreadCount ?? 0
        }))
    ]
      .filter(p => {
        const matchesSearch = !searchTerm || 
          p.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
          p.client?.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
          p.city?.toLowerCase().includes(searchTerm.toLowerCase());
        
        return matchesSearch;
      })
      .sort((a, b) => 
        new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime()
      );
  }, [projectsFromCache, emergencyProjects, initialProjects, pendingProjects, unreadCounts, searchTerm, isHydratingAuth])

  const paginatedProjects = useMemo(() => {
    if (!projects) return undefined;
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return projects.slice(start, start + ITEMS_PER_PAGE);
  }, [projects, currentPage]);

  const totalPages = Math.ceil((projects?.length || 0) / ITEMS_PER_PAGE);

  useEffect(() => {
    setCurrentPage(1); // Reset page on search
  }, [searchTerm]);

  // v352: Delete project — same 2-step modal as admin
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteStep, setDeleteStep] = useState(1);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [projectToDelete, setProjectToDelete] = useState<any>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const openDeleteModal = (project: any, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setProjectToDelete(project);
    setDeleteStep(1);
    setDeleteConfirmText('');
    setShowDeleteModal(true);
  };

  const executeDelete = async () => {
    if (!projectToDelete) return;
    if (deleteConfirmText !== (projectToDelete.title || '')) return;
    
    setIsDeleting(true);
    try {
      const pId = projectToDelete.id;
      const isPending = projectToDelete.isPending === true || String(pId).startsWith('pending-');

      if (isPending) {
        // v420: For pending projects, just remove from outbox and local cache
        const numericId = Number(String(pId).replace('pending-', ''));
        if (!isNaN(numericId)) {
          await db.outbox.delete(numericId);
        }
      } else {
        // v421: Try online delete first, fallback to outbox if offline
        let success = false;
        try {
          const res = await fetch(`/api/projects/${pId}`, { method: 'DELETE' });
          if (res.ok) success = true;
        } catch (e) {
          console.warn('[Delete] Fetch failed, queuing for sync...');
        }

        if (!success) {
          // Queue in outbox if fetch failed or returned error (offline case)
          await db.outbox.add({
            type: 'PROJECT_DELETE',
            projectId: Number(pId),
            payload: { id: pId },
            timestamp: Date.now(),
            status: 'pending'
          });
        }
      }

      // v422: Deep cleanup of local tables to free space
      await db.projectsCache.delete(pId);
      await db.chatCache.delete(pId);
      // Clean appointments associated with this project locally
      const apptsToDelete = await db.appointmentsCache.where('projectId').equals(Number(pId)).toArray();
      if (apptsToDelete.length > 0) {
        await db.appointmentsCache.bulkDelete(apptsToDelete.map(a => a.id));
      }

      // Cleanup snapshots to prevent "ghost projects"
      setEmergencyProjects(prev => prev ? prev.filter(p => p.id !== pId) : []);
      
      try {
        const saved = localStorage.getItem('last_op_projects_snapshot');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) {
            const filtered = parsed.filter(p => p.id !== pId);
            localStorage.setItem('last_op_projects_snapshot', JSON.stringify(filtered));
          }
        }
      } catch (e) {}

      setShowDeleteModal(false);
      setProjectToDelete(null);
    } catch (err) {
      console.error('[OpDashboard] Delete failed:', err);
      alert('Error al intentar eliminar el proyecto localmente');
    } finally {
      setIsDeleting(false);
    }
  };

  const [selectedTask, setSelectedTask] = useState<any>(null)

  const canManageCalendar = hasModuleAccess(user, 'calendario')

  // 1. Initial hydration and offline cache for appointments
  const syncTriggeredRef = useRef(false);

  // v289/v302: Stable warm-cache logic with 30min throttling
  const warmedProjectIdsRef = useRef<Set<number>>(new Set());
  
  useEffect(() => {
    const triggerWarmCache = async () => {
      if (!projects || projects.length === 0 || !navigator.onLine) return;

      // v302: Use the same cache key as CacheManager to ensure sync consistency
      const userId = user?.id || localUser?.id || 'default';
      const cacheKey = `projects_bulk_${userId}`;
      
      // 30min Throttling check
      const meta = await db.cacheMetadata.get(cacheKey);
      if (meta?.lastSync) {
        const minsSinceLastSync = (Date.now() - meta.lastSync) / 60000;
        if (minsSinceLastSync < 30) {
          // console.log(`[WarmCache-Op] Skipping. Last sync was ${Math.round(minsSinceLastSync)}m ago.`);
          return;
        }
      }
      
      // Extract only stable IDs to compare
      const currentIds = projects.slice(0, 20)
        .filter(p => p.id && !String(p.id).startsWith('pending'))
        .map(p => Number(p.id));
      
      // Check if we have any new projects to warm
      const newIds = currentIds.filter(id => !warmedProjectIdsRef.current.has(id));
      
      if (newIds.length > 0) {
        const urls = newIds.map(id => `/admin/operador/proyecto/${id}`);
        console.log(`[WarmCache] Messaging SW to pre-cache ${urls.length} NEW operator projects`);
        
        if (navigator.serviceWorker?.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'PRECACHE_URLS',
            urls
          });
          // Mark as warmed
          newIds.forEach(id => warmedProjectIdsRef.current.add(id));
          
          // v315: Removed db.cacheMetadata.update(cacheKey, { status: 'syncing' })
          // Warm caching now happens silently in the background without disturbing the green UI.
        }
      }
    };

    triggerWarmCache();
  }, [projects?.length, user?.id, localUser?.id]);

  // v264: Instant Outbox Kick - Force sync and refresh projects when returning to focus or online
  useEffect(() => {
    const triggerSync = async () => {
      if (typeof window !== 'undefined' && navigator.serviceWorker.controller && navigator.onLine) {
        // Trigger the outbox sync explicitly
        navigator.serviceWorker.controller.postMessage({ type: 'FORCE_SYNC_OUTBOX' });
      }
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        refreshProjectsList();
      }
    };

    window.addEventListener('focus', triggerSync);
    window.addEventListener('online', triggerSync);
    triggerSync(); // Initial trigger

    return () => {
      window.removeEventListener('focus', triggerSync);
      window.removeEventListener('online', triggerSync);
    };
  }, [user?.id, localUser?.id]);



  // 2. Local outbox tasks (created offline)
  const pendingTasksRaw = useLiveQuery(
    () => db.outbox.where('type').equals('TASK').toArray()
  ) || []
  
  const pendingStatusToggles = useLiveQuery(
    () => db.outbox.where('type').equals('TASK_STATUS_TOGGLE').toArray()
  ) || []

  // 3. Merge server appointments + local pending tasks + pending status toggles
  const allAppointments = useMemo(() => {
    // Priority: use cached appointments if available, fallback to props
    let baseAppts = appointmentsFromCache || appointments || []
    let merged = [...baseAppts]

    // Apply pending status toggles
    pendingStatusToggles.forEach(toggle => {
      const idx = merged.findIndex(a => a.id === toggle.payload.appointmentId)
      if (idx !== -1) {
        merged[idx] = { ...merged[idx], status: toggle.payload.status }
      }
    })

    const pendingMapped = pendingTasksRaw.map(t => ({
      ...t.payload,
      id: `pending-${t.id}`, // pseudo-id
      status: t.payload.status || 'PENDIENTE',
      startTime: new Date(t.payload.startTime),
      endTime: new Date(t.payload.endTime),
      project: (projects || []).find((p: any) => p.id === Number(t.payload.projectId)) || null,
      isOffline: true // flag for UI
    }))
    // v360: Deduplicate pending tasks that have already been synced
    const finalResult: any[] = [...merged];
    const seenMap = new Set();
    
    // Add real appointments to seenMap
    finalResult.forEach(ra => {
      try {
        if (ra.startTime) {
          const timeStr = new Date(ra.startTime).toISOString().slice(0, 16); // Minute precision
          seenMap.add(`${ra.title}_${ra.projectId}_${timeStr}`);
        }
      } catch (e) { /* Ignore invalid dates */ }
    });

    pendingMapped.forEach(pt => {
      try {
        if (pt.startTime) {
          const timeStr = new Date(pt.startTime).toISOString().slice(0, 16);
          const key = `${pt.title}_${pt.projectId}_${timeStr}`;
          
          if (!seenMap.has(key)) {
            finalResult.push(pt);
            seenMap.add(key);
          }
        } else {
          finalResult.push(pt);
        }
      } catch (e) { 
        finalResult.push(pt); 
      }
    });

    return finalResult.sort((a, b) => {
      const tA = new Date(a.startTime).getTime()
      const tB = new Date(b.startTime).getTime()
      if (isNaN(tA) && isNaN(tB)) return 0;
      if (isNaN(tA)) return 1;
      if (isNaN(tB)) return -1;
      return tA - tB;
    })
  }, [appointments, appointmentsFromCache, pendingTasksRaw, pendingStatusToggles, projects])

  const [pushDismissed, setPushDismissed] = useState(true)
  const { 
    status: pushStatus, 
    subscribe: pushSubscribe, 
    isSubscribing,
    showOnboarding,
    setShowOnboarding 
  } = usePushNotifications()

  // Show push banner if not subscribed and not recently dismissed
  useEffect(() => {
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

  // Legacy localStorage Cleanup (One-time)
  useEffect(() => {
    const legacy = localStorage.getItem('offlineProjects')
    if (legacy) {
      try {
        const parsed = JSON.parse(legacy)
        parsed.forEach(async (p: any) => {
          await db.outbox.add({
            type: 'PROJECT',
            projectId: 0,
            payload: p.payload,
            timestamp: Date.now(),
            status: 'pending'
          })
        })
        localStorage.removeItem('offlineProjects')
      } catch (e) {}
    }
  }, [])

  const totalUnread = useMemo(() => {
    return projects?.reduce((acc, p) => acc + (p.unreadCount || 0), 0) || 0
  }, [projects])

  const todayTasks = useMemo(() => {
    const today = getLocalNow()
    return allAppointments
      .filter(a => {
        const d = new Date(a.startTime)
        return d.getDate() === today.getDate() && 
               d.getMonth() === today.getMonth() && 
               d.getFullYear() === today.getFullYear()
      })
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
  }, [allAppointments])

  const toggleStatus = async (task: any) => {
    if (task.isOffline) {
      alert('Esta tarea aún no se ha sincronizado con el servidor. Por favor, espera a tener conexión para marcarla como completada.')
      return
    }

    const newStatus = task.status === 'COMPLETADA' ? 'PENDIENTE' : 'COMPLETADA'

    // Actualización optimista local
    // Nota: Como usamos LiveQuery, la actualización vendrá de DB si guardamos en outbox o esperamos respuesta
    try {
      const res = await fetch(`/api/appointments/${task.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      })
      if (!res.ok) throw new Error('Network error')
      
      // Update local cache for instant feedback if online
      await db.appointmentsCache.update(task.id, { status: newStatus })
    } catch (e) {
      console.warn('[Offline] Task status toggle failed or offline, adding to outbox')
      await db.outbox.add({
        type: 'TASK_STATUS_TOGGLE',
        projectId: task.project?.id || task.projectId || 0,
        payload: { appointmentId: task.id, status: newStatus },
        timestamp: Date.now(),
        status: 'pending'
      })
      // v333: Trigger sync after adding to outbox
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'FORCE_SYNC_OUTBOX' });
        // v334: Push silencioso si hay internet
        if (navigator.onLine) {
          fetch('/api/push/wake-up', { method: 'POST', priority: 'low' }).catch(() => {});
        }
      }
    }
  }

  return (
    <div className="operator-dashboard">
      <div className="operator-header">
        <div className="operator-welcome" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', flexWrap: 'wrap', gap: '15px' }}>
          <div>
            <h1 className="page-title">Hola, {(localUser?.name || user?.name || 'Operador').split(' ')[0]}</h1>
            <p className="page-subtitle">Panel de Control de Operaciones</p>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
             <ManualSyncButton />
              <Link 
                href="/admin/operador/nuevo"
                className="btn btn-secondary"
              >
                Crear Proyecto
              </Link>
          </div>
        </div>
      </div>

      <IosInstallBanner />

      <div style={{ marginTop: '15px' }}>
        <ProjectCacheManager userId={localUser?.id || user?.id} />
      </div>

      {showOnboarding && (
        <NotificationOnboarding onDone={() => setShowOnboarding(false)} />
      )}

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
          margin: '15px 0 0 0',
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
                  : 'Activa las Notificaciones'}
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
                  : 'Recibe alertas de mensajes y tareas en tu celular'}
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

      <div className="tabs tabs-nowrap" style={{ 
        marginTop: 'var(--space-lg)', 
        display: 'flex', 
        width: '100%', 
        gap: '0',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(255,255,255,0.02)',
        borderRadius: '12px 12px 0 0',
        overflow: 'hidden'
      }}>
        <button 
          className={`tab ${activeTab === 'TAREAS' ? 'active' : ''}`}
          onClick={() => setActiveTab('TAREAS')}
          style={{ 
            flex: 1, 
            padding: '16px 10px', 
            fontSize: '0.9rem', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            gap: '10px',
            borderRadius: '0',
            borderBottom: activeTab === 'TAREAS' ? '3px solid var(--primary)' : '3px solid transparent'
          }}
        >
           <CheckCircle2 size={18} /> 
           <span style={{ whiteSpace: 'nowrap', fontWeight: activeTab === 'TAREAS' ? '700' : '500' }}>
             Hoy ({allAppointments === undefined ? '...' : todayTasks.length})
           </span>
        </button>

        <button 
          className={`tab ${activeTab === 'PROYECTOS' ? 'active' : ''}`} 
          onClick={() => setActiveTab('PROYECTOS')}
          style={{ 
            flex: 1, 
            padding: '16px 10px', 
            fontSize: '0.9rem', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            gap: '10px',
            borderRadius: '0',
            borderBottom: activeTab === 'PROYECTOS' ? '3px solid var(--primary)' : '3px solid transparent',
            position: 'relative'
          }}
        >
           <Briefcase size={18} /> 
           <span style={{ whiteSpace: 'nowrap', fontWeight: activeTab === 'PROYECTOS' ? '700' : '500' }}>
            Proyectos ({projects === undefined ? '...' : projects.length})
           </span>
           {totalUnread > 0 && (
             <span className="tab-badge" style={{ position: 'static', marginLeft: '8px', transform: 'none' }}>
               {totalUnread}
             </span>
           )}
        </button>
      </div>

      {activeTab === 'PROYECTOS' && (
        <div style={{ marginTop: '20px' }}>
          <div className="search-container" style={{ marginBottom: '20px' }}>
            <div className="input-group" style={{ backgroundColor: 'var(--bg-input)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
              <span className="input-group-text bg-transparent border-0 pe-0">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.5 }}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              </span>
              <input 
                type="text" 
                className="form-control bg-transparent border-0 ps-3" 
                placeholder="Buscar por proyecto, cliente o ciudad..." 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                style={{ fontSize: '1rem', height: '54px', color: 'var(--text)' }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Action header depending on active tab */}


      <div className="tab-content" style={{ marginTop: 'var(--space-sm)' }}>
        {activeTab === 'TAREAS' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
            {todayTasks.length > 0 ? todayTasks.map(task => (
              <div key={task.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', padding: 'var(--space-md)' }}>
                <button 
                  onClick={() => toggleStatus(task)}
                  style={{ background: 'none', border: 'none', color: task.status === 'COMPLETADA' ? 'var(--success)' : 'var(--text-muted)', cursor: 'pointer' }}
                >
                  <CheckCircle2 size={24} fill={task.status === 'COMPLETADA' ? 'var(--success-bg)' : 'none'}/>
                </button>
                <div 
                  style={{ flex: 1, cursor: 'pointer' }}
                  onClick={() => setSelectedTask(task)}
                >
                   <h3 style={{ margin: 0, fontSize: '1.1rem', textDecoration: task.status === 'COMPLETADA' ? 'line-through' : 'none', opacity: task.status === 'COMPLETADA' ? 0.6 : 1 }}>
                     {task.title}
                   </h3>
                   <div style={{ display: 'flex', gap: '1rem', fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Clock size={12}/> {formatToEcuador(task.startTime, { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {task.project && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <Briefcase size={12}/> {task.project.title}
                        </span>
                      )}
                   </div>
                </div>
                <span className={`badge ${task.status === 'COMPLETADA' ? 'badge-success' : 'badge-warning'}`}>
                   {task.status}
                </span>
              </div>
            )) : (
              <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
                <p style={{ color: 'var(--text-muted)' }}>No tienes tareas agendadas para hoy.</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'PROYECTOS' && (
          <div className="grid-responsive">
            {paginatedProjects === undefined ? (
               <div style={{ gridColumn: '1 / -1', padding: '60px 20px', textAlign: 'center', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '20px', border: '1px dashed rgba(255,255,255,0.1)' }}>
                  <div className="loading-spinner" style={{ width: '30px', height: '30px', margin: '0 auto 15px' }} />
                  <p style={{ color: 'var(--text-muted)' }}>Hidratando proyectos desde memoria local...</p>
               </div>
            ) : paginatedProjects.length > 0 ? (
              <>
                {paginatedProjects.map(project => {
                  const completedPhases = (project.phases || []).filter((p: any) => p.status === 'COMPLETADA').length
                  const totalPhases = (project.phases || []).length
                  const progress = totalPhases > 0 ? Math.round((completedPhases / totalPhases) * 100) : 0
                  const isPending = project.isPending === true
                  
                  return (
                    <Link 
                      href={isPending ? '#' : `/admin/operador/proyecto/${project.id}`} 
                      key={project.id} 
                      prefetch={false}
                      onClick={(e) => {
                        if (!project.id || isPending) return;
                        // v289: Store ID in sessionStorage as emergency fallback for offline-shell
                        sessionStorage.setItem('last_op_project_id', String(project.id));
                        console.log('[OpNav] Navigating to project:', project.id);
                        
                        // v359: Removed window.location.href forced reload.
                        // Now we rely on RSC pre-caching for a smooth soft-navigation offline.
                      }}
                      className="card interactive" 
                      style={{ textDecoration: 'none', display: 'flex', flexDirection: 'column', opacity: isPending ? 0.8 : 1, cursor: isPending ? 'default' : 'pointer', position: 'relative' }}
                    >
                      {/* v352: Delete button — opens 2-step confirmation modal */}
                      <button
                        onClick={(e) => openDeleteModal(project, e)}
                        title="Eliminar proyecto"
                        style={{
                          position: 'absolute',
                          top: '8px',
                          right: '8px',
                          zIndex: 5,
                          background: 'rgba(239, 68, 68, 0.15)',
                          border: '1px solid rgba(239, 68, 68, 0.3)',
                          color: '#ef4444',
                          width: '28px',
                          height: '28px',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '0.8rem',
                          opacity: 1,
                          transition: 'all 0.2s'
                        }}
                      >
                        ✕
                      </button>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '15px', paddingRight: '30px' }}>
                        {isPending ? (
                          <span style={{ backgroundColor: 'rgba(245, 158, 11, 0.9)', color: 'white', padding: '4px 10px', borderRadius: '8px', fontSize: '0.7rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                            PENDIENTE DE SINCRONIZACIÓN
                          </span>
                        ) : (
                          <span className={`status-badge status-${project.status.toLowerCase()}`}>
                            {project.status}
                          </span>
                        )}
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{(project.phases || []).length} fases</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                        <div style={{ flex: 1 }}>
                          <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text)' }}>{project.title}</h3>
                          {(project.city || project.client?.city) && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                              📍 {project.city || project.client?.city}
                            </div>
                          )}
                        </div>
                        {project.unreadCount > 0 && (
                          <span className="unread-dot-badge" title="Mensajes sin leer">
                            {project.unreadCount}
                          </span>
                        )}
                      </div>
                      <div style={{ marginTop: 'auto' }}>
                        <div className="progress-bar" style={{ height: '4px' }}>
                          <div className="progress-fill" style={{ width: `${progress}%` }}></div>
                        </div>
                      </div>
                    </Link>
                  )
                })}
                
                {/* Pagination Controls */}
                {totalPages > 1 && (
                  <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '15px', marginTop: '30px', padding: '15px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '15px' }}>
                    <button 
                      onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                      disabled={currentPage === 1}
                      className="btn btn-ghost"
                      style={{ 
                        opacity: currentPage === 1 ? 0.2 : 1, 
                        color: 'var(--text-secondary)',
                        fontSize: '0.85rem',
                        padding: '8px 16px'
                      }}
                    >
                      ← Anterior
                    </button>
                    <div style={{ 
                      backgroundColor: 'var(--bg-surface)', 
                      padding: '6px 14px', 
                      borderRadius: '8px',
                      fontSize: '0.85rem',
                      fontWeight: '600',
                      color: 'var(--primary)',
                      border: '1px solid var(--border)'
                    }}>
                      {currentPage} / {totalPages}
                    </div>
                    <button 
                      onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                      disabled={currentPage === totalPages}
                      className="btn btn-ghost"
                      style={{ 
                        opacity: currentPage === totalPages ? 0.2 : 1, 
                        color: 'var(--text-secondary)',
                        fontSize: '0.85rem',
                        padding: '8px 16px'
                      }}
                    >
                      Siguiente →
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div style={{ gridColumn: '1 / -1', padding: '60px 20px', textAlign: 'center', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '20px', border: '1px dashed rgba(255,255,255,0.1)' }}>
                <div style={{ fontSize: '2.5rem', marginBottom: '20px', opacity: 0.3 }}>📂</div>
                <h3 style={{ fontSize: '1.1rem', marginBottom: '8px' }}>No hay proyectos disponibles</h3>
                <p style={{ color: 'var(--text-muted)', maxWidth: '300px', margin: '0 auto', fontSize: '0.9rem' }}>
                  Si crees que esto es un error, intenta sincronizar manualmente o conectar a internet.
                </p>
                <button 
                  onClick={() => window.dispatchEvent(new CustomEvent('trigger-bulk-sync', { detail: { force: true } }))}
                  className="btn btn-outline btn-sm"
                  style={{ marginTop: '20px' }}
                >
                  Sincronizar ahora
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'CALENDARIO' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
            <div className="card" style={{ padding: 'var(--space-md)', background: 'rgba(56, 189, 248, 0.05)', border: '1px solid rgba(56, 189, 248, 0.2)' }}>
              <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text)' }}>
                <strong>📅 Agenda Semanal</strong>: Aquí puedes ver tus próximos compromisos y tareas asignadas.
              </p>
            </div>
            
            {allAppointments.length > 0 ? (
              // Agrupar por fecha
              Object.entries(
                allAppointments.reduce((acc: any, curr) => {
                  const date = new Date(curr.startTime).toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long' });
                  if (!acc[date]) acc[date] = [];
                  acc[date].push(curr);
                  return acc;
                }, {})
              ).sort((a: any, b: any) => {
                const tA = new Date(a[1][0].startTime).getTime();
                const tB = new Date(b[1][0].startTime).getTime();
                if (isNaN(tA) && isNaN(tB)) return 0;
                if (isNaN(tA)) return 1;
                if (isNaN(tB)) return -1;
                return tA - tB;
              }).map(([date, tasks]: [string, any]) => (
                <div key={date} style={{ marginBottom: '10px' }}>
                  <h4 style={{ fontSize: '0.85rem', color: 'var(--primary)', textTransform: 'capitalize', marginBottom: '8px', paddingLeft: '10px', borderLeft: '3px solid var(--primary)' }}>
                    {date}
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {tasks.sort((a: any, b: any) => {
                      const tA = new Date(a.startTime).getTime();
                      const tB = new Date(b.startTime).getTime();
                      if (isNaN(tA) && isNaN(tB)) return 0;
                      if (isNaN(tA)) return 1;
                      if (isNaN(tB)) return -1;
                      return tA - tB;
                    }).map((task: any) => (
                      <div key={task.id} className="card interactive" style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '12px' }} onClick={() => setSelectedTask(task)}>
                        <div style={{ textAlign: 'center', minWidth: '50px' }}>
                          <div style={{ fontSize: '0.9rem', fontWeight: 'bold' }}>{formatToEcuador(task.startTime, { hour: '2-digit', minute: '2-digit' })}</div>
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: '600', fontSize: '0.95rem' }}>{task.title}</div>
                          {task.project && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>📂 {task.project.title}</div>}
                        </div>
                        <span className={`badge ${task.status === 'COMPLETADA' ? 'badge-success' : 'badge-warning'}`} style={{ fontSize: '0.65rem' }}>
                          {task.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
                <p style={{ color: 'var(--text-muted)' }}>No tienes tareas para esta semana.</p>
              </div>
            )}
            
            <div style={{ textAlign: 'center', marginTop: '20px' }}>
              <Link href="/admin/calendario" className="btn btn-outline" style={{ fontSize: '0.8rem' }}>
                Ver Calendario Completo ↗
              </Link>
            </div>
          </div>
        )}


      </div>

      {/* MODAL DETALLES DE TAREA (Multimedia support) */}
      {selectedTask && (
        <AppointmentModal
          isOpen={!!selectedTask}
          onClose={() => setSelectedTask(null)}
          onSave={async (data) => {
            try {
              const res = await fetch(`/api/appointments/${data.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
              })
              if (res.ok) {
                // Update local cache
                await db.appointmentsCache.put(data)
                setSelectedTask(null)
              } else {
                alert('Error al actualizar tarea')
              }
            } catch (e) {
              alert('Error de conexión. Las ediciones detalladas requieren internet.')
            }
          }}
          initialData={selectedTask}
          userId={Number(user.id)}
          projects={projects || []}
          operators={[user]} // El operador solo se ve a sí mismo generalmente
          isAdminView={false}
        />
      )}
      


      {/* v352: DELETE PROJECT MODAL — same 2-step confirmation as admin */}
      {showDeleteModal && projectToDelete && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div className="card" style={{ maxWidth: '500px', width: '100%', padding: '40px', border: '1px solid rgba(239, 68, 68, 0.4)', textAlign: 'center' }}>
            {deleteStep === 1 ? (
              <>
                <div style={{ width: '80px', height: '80px', borderRadius: '50%', backgroundColor: 'rgba(239, 68, 68, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 25px auto', color: 'var(--danger)' }}>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                </div>
                <h3 style={{ fontSize: '1.5rem', marginBottom: '15px' }}>¿Eliminar este proyecto?</h3>
                <p style={{ color: 'var(--text-muted)', lineHeight: '1.6', marginBottom: '30px' }}>
                  Estás a punto de borrar <strong>{projectToDelete.title}</strong>.<br/> Todos los datos asociados se destruirán de forma inmediata e irreversible.
                  {projectToDelete.isPending && <><br/><span style={{ color: '#f59e0b', fontSize: '0.85rem' }}>(Proyecto pendiente de sincronización — se eliminará del dispositivo)</span></>}
                </p>
                <div style={{ display: 'flex', gap: '15px' }}>
                  <button onClick={() => { setShowDeleteModal(false); setProjectToDelete(null); }} style={{ flex: 1, padding: '14px', borderRadius: '10px', background: 'var(--bg-surface)', border: '1px solid var(--border-color)', color: 'white', cursor: 'pointer' }}>Cancelar</button>
                  <button onClick={() => setDeleteStep(2)} style={{ flex: 1, padding: '14px', borderRadius: '10px', backgroundColor: 'var(--danger)', border: 'none', color: 'white', fontWeight: 'bold', cursor: 'pointer' }}>Entiendo, continuar</button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ fontSize: '1.3rem', marginBottom: '15px' }}>Verificación Final</h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem', marginBottom: '20px' }}>
                  Para confirmar la eliminación, escribe el nombre del proyecto:
                </p>
                <div style={{ backgroundColor: 'rgba(255,255,255,0.05)', padding: '12px', borderRadius: '8px', marginBottom: '20px', fontWeight: 'bold', color: 'var(--primary)', letterSpacing: '0.5px' }}>
                  {projectToDelete.title}
                </div>
                <input 
                  type="text" 
                  autoFocus
                  placeholder="Escribe el nombre aquí..."
                  value={deleteConfirmText}
                  onChange={e => setDeleteConfirmText(e.target.value)}
                  style={{ width: '100%', padding: '15px', backgroundColor: 'var(--bg-deep)', border: `2px solid ${deleteConfirmText === projectToDelete.title ? 'var(--success)' : 'var(--border-color)'}`, borderRadius: '10px', color: 'white', textAlign: 'center', fontSize: '1.1rem', marginBottom: '25px', outline: 'none' }}
                />
                <div style={{ display: 'flex', gap: '15px' }}>
                  <button 
                    onClick={() => { setDeleteStep(1); setDeleteConfirmText(''); }} 
                    style={{ flex: 1, padding: '14px', borderRadius: '10px', background: 'var(--bg-surface)', border: '1px solid var(--border-color)', color: 'white', cursor: 'pointer' }}
                  >
                    Atrás
                  </button>
                  <button 
                    onClick={executeDelete}
                    disabled={isDeleting || deleteConfirmText !== projectToDelete.title}
                    style={{ flex: 1, padding: '14px', borderRadius: '10px', backgroundColor: deleteConfirmText === projectToDelete.title ? 'var(--danger)' : 'rgba(239, 68, 68, 0.3)', border: 'none', color: 'white', fontWeight: 'bold', cursor: deleteConfirmText === projectToDelete.title ? 'pointer' : 'not-allowed', opacity: deleteConfirmText === projectToDelete.title ? 1 : 0.6 }}
                  >
                    {isDeleting ? 'Eliminando...' : 'BORRAR TODO'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <style jsx>{`
        .tab-badge {
          background: var(--danger);
          color: white;
          font-size: 0.7rem;
          padding: 2px 6px;
          border-radius: 10px;
          margin-left: 8px;
          font-weight: bold;
        }
        .unread-dot-badge {
          background: var(--danger);
          color: white;
          font-size: 0.75rem;
          min-width: 20px;
          height: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 10px;
          font-weight: bold;
          box-shadow: 0 2px 4px rgba(0,0,0,0.2);
          margin-left: 10px;
        }
      `}</style>
      {/* Sync Notification Toast */}
      {syncNotification && (
        <div 
          className="fixed z-[10000] animate-bounce-in"
          style={{ 
            bottom: '100px', 
            left: '50%', 
            transform: 'translateX(-50%)',
            width: 'calc(100% - 40px)', 
            maxWidth: '400px' 
          }}
        >
          <div className="bg-green-600 text-white p-4 rounded-2xl shadow-2xl flex items-center gap-4 border border-white/20 backdrop-blur-md">
            <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center text-xl">
              ✅
            </div>
            <div className="flex-1">
              <p className="font-bold text-sm">Proyecto Sincronizado</p>
              <p className="text-xs opacity-90 line-clamp-1">{syncNotification.title}</p>
            </div>
            <button 
              onClick={() => setSyncNotification(null)}
              className="p-2 hover:bg-white/10 rounded-lg"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <style jsx global>{`
        @keyframes bounce-in {
          0% { transform: translate(-50%, 100px); opacity: 0; }
          60% { transform: translate(-50%, -15px); opacity: 1; }
          100% { transform: translate(-50%, 0); }
        }
        .animate-bounce-in { animation: bounce-in 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards; }
      `}</style>
    </div>
  )
}
