'use client'

import { useEffect, useState, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { db } from '@/lib/db'

// ─── v333: Centralized logging to IndexedDB (visible in /admin/debug/sync) ───
async function logSync(level: 'info' | 'warn' | 'error' | 'success', message: string, type = 'system', details?: string) {
  try {
    const count = await db.syncLogs.count();
    if (count > 250) {
      const oldest = await db.syncLogs.orderBy('timestamp').first();
      if (oldest?.id) await db.syncLogs.delete(oldest.id);
    }
    await db.syncLogs.add({
      timestamp: Date.now(),
      level,
      message,
      type,
      details: details || ''
    });
  } catch (e) {
    // Silent — don't break sync if logging fails
  }
}

// v261: Global throttle to prevent sync loops on component remounts (caused by router.refresh)
let lastSyncExecution = 0;
// v291: Separate throttle for heavy bulk sync to prevent constant re-triggering
let lastBulkSyncAttempt = 0;

/**
 * v400: Exported helper to trigger outbox sync from anywhere
 */
export function triggerBackgroundSync() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('trigger-outbox-sync'));
  }
}

export default function GlobalSyncWorker() {
  const { data: session } = useSession()
  const router = useRouter()
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const [isSyncing, setIsSyncing] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<any>(null);
  const syncLock = useRef(false)
  const outboxLock = useRef(false) // v272: Separate lock — outbox sync must NEVER be blocked by bulk sync
  
  // v261: PWA Visibility Fallback (Critical for iOS/Safari)
  // When app returns to foreground, proactively wake up the Service Worker sync
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        // console.log('[Sync] App returned to focus. Triggering background sync fallback...');
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.ready.then(reg => {
            if ('sync' in reg) {
              // Consolidate to one registration to avoid duplicate SW wakeups
              // v273: Register specific tags as well for better reliability
              const sync = (reg as any).sync;
              sync.register('sync-outbox').catch(() => {});
              sync.register('sync-MESSAGE').catch(() => {});
              sync.register('sync-EXPENSE').catch(() => {});
              sync.register('sync-TASK').catch(() => {});
              sync.register('sync-PROJECT').catch(() => {});
            }
          });
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // v300: Listen for REAL upload progress from Service Worker
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'UPLOAD_PROGRESS') {
        setUploadProgress(event.data);
      } else if (event.data?.type === 'OUTBOX_SYNC_FINISHED') {
        setTimeout(() => setUploadProgress(null), 3000); // 3s extra visibility
      }
    };
    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, []);
  
  // States for bulk cache sync (background)
  const [isBulkSyncing, setIsBulkSyncing] = useState(false)
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 })
  
  // v471: Native-specific states for battery optimization and platform detection
  const [isNativePlatform, setIsNativePlatform] = useState(false)
  const [showBatteryWarning, setShowBatteryWarning] = useState(false)

  // Automatic Trigger: Start sync when session is available and we are online
  useEffect(() => {
    if (session?.user?.id && navigator.onLine && !isBulkSyncing) {
      // v373: Reduced to 1s for dev mode — Fast Refresh resets longer timers
      const timer = setTimeout(() => {
        startBulkSync();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [session?.user?.id, isOnline]);

  // v471: Detect native platform and check battery optimization status on launch
  useEffect(() => {
    async function checkBatteryExemption() {
      try {
        const { isNative, BatteryBridge } = await import('@/lib/native-bridge');
        if (!isNative()) return;
        
        setIsNativePlatform(true);
        
        // Dynamic wait time before showing the battery optimization banner (5 seconds)
        setTimeout(async () => {
          const exempt = await BatteryBridge.isExempt();
          if (!exempt) {
            setShowBatteryWarning(true);
          }
        }, 5000);
      } catch (err) {
        console.error('[BatteryDefense] Error checking status:', err);
      }
    }
    checkBatteryExemption();
  }, []);

  // v471: Listen for real-time background Kotlin synchronization service broadcasts
  useEffect(() => {
    let active = true;
    
    async function setupNativeListener() {
      try {
        const { isNative, SyncBridge } = await import('@/lib/native-bridge');
        if (!isNative()) return;
        
        console.log('[NativeSync] Hooking into Kotlin BroadcastReceiver channels...');
        
        SyncBridge.onSyncEvent(async (event: any) => {
          if (!active) return;
          console.log('[NativeSync] Broadcast captured in WebView:', event);
          
          const { syncId, status, errorMessage, serverData } = event;
          if (!syncId) return;
          
          // Locate the element in Dexie IndexedDB outbox queue
          const localItem = await db.outbox.where('syncId').equals(syncId).first();
          
          if (status === 'COMPLETED') {
            if (localItem) {
              await db.outbox.delete(localItem.id!);
              console.log(`[NativeSync] Cleaned completed item ${syncId} from IndexedDB outbox`);
              
              // Generate descriptive notifications matching item types
              const syncLabel = localItem.type === 'GALLERY_UPLOAD' ? 'Archivo subido a galería' :
                                localItem.type === 'MESSAGE' ? 'Mensaje enviado' :
                                localItem.type === 'MEDIA_UPLOAD' ? 'Archivo multimedia enviado' :
                                localItem.type === 'PROJECT' ? 'Proyecto creado correctamente' :
                                localItem.type === 'EXPENSE' ? 'Gasto registrado offline' :
                                localItem.type === 'TASK' ? 'Tarea sincronizada' :
                                `Sincronización completa (${localItem.type})`;
              
              // Notify UI for dynamic toast and state refreshes
              window.dispatchEvent(new CustomEvent('sync-success', { detail: { 
                type: localItem.type, 
                projectId: localItem.projectId, 
                label: syncLabel,
                payload: localItem.payload,
                result: { success: true }
              } }));
              
              await logSync('success', `✓ Sincronizado nativo: ${localItem.type}`, localItem.type);
            }
          } else if (status === 'FAILED') {
            if (localItem) {
              await db.outbox.update(localItem.id!, { 
                status: 'failed', 
                attempts: 10, 
                failReason: errorMessage || 'Fallo en canal de servicio nativo' 
              });
              await logSync('error', `Fallo nativo: ${localItem.type} - ${errorMessage}`, localItem.type);
            }
          } else if (status === 'SYNCING') {
            if (localItem) {
              await db.outbox.update(localItem.id!, { status: 'syncing' });
            }
          } else if (status === 'CONFLICT') {
            if (localItem) {
              await db.outbox.update(localItem.id!, { 
                status: 'failed', 
                failReason: 'CONFLICT' 
              });
              
              // Bubble conflict events up to the dashboard client
              window.dispatchEvent(new CustomEvent('sync-conflict', { detail: {
                syncId,
                type: localItem.type,
                projectId: localItem.projectId,
                localData: localItem.payload,
                serverData: serverData ? JSON.parse(serverData) : null
              } }));
              await logSync('warn', `Conflicto detectado: ${localItem.type}. Esperando resolución del usuario.`, localItem.type);
            }
          } else if (status === 'AUTH_REQUIRED') {
            if (localItem) {
              await db.outbox.update(localItem.id!, { status: 'pending' });
              window.dispatchEvent(new CustomEvent('sync-auth-required'));
              await logSync('error', 'Sesión expirada. Se requiere login para continuar sincronización.', 'auth');
            }
          }
        });
      } catch (err) {
        console.error('[NativeSync] Failed to bind event channels:', err);
      }
    }
    
    setupNativeListener();
    return () => { active = false; };
  }, []);

  // v471: Executed exactly once on first app launch to migrate legacy IndexedDB outbox to Room DB
  useEffect(() => {
    async function triggerMigration() {
      try {
        const { isNative, MigrationBridge } = await import('@/lib/native-bridge');
        if (!isNative()) return;
        
        const needed = await MigrationBridge.checkNeeded();
        if (needed) {
          console.log('[Migration] Starting IndexedDB -> Room DB background transition...');
          await logSync('info', 'Iniciando migración única de datos offline...', 'migration');
          
          const items = await db.outbox.toArray();
          if (items.length > 0) {
            const imported = await MigrationBridge.importOutboxItems(items);
            console.log(`[Migration] Transitioned ${imported} outbox entries successfully.`);
            await logSync('success', `Migrados ${imported} elementos pendientes a base de datos nativa Room DB`, 'migration');
          }
          
          // Finalize migration lock to prevent repetitive checks
          await MigrationBridge.markComplete();
        }
      } catch (err) {
        console.error('[Migration] Failed to migrate local data:', err);
      }
    }
    
    const timer = setTimeout(triggerMigration, 3000);
    return () => clearTimeout(timer);
  }, []);

  // Battery exemption triggers
  const handleRequestExemption = async () => {
    try {
      const { BatteryBridge } = await import('@/lib/native-bridge');
      await BatteryBridge.requestBatteryExemption();
      setShowBatteryWarning(false);
    } catch (err) {
      console.error('[BatteryDefense] Could not request exemption:', err);
    }
  };

  const startBulkSync = async (initialProjects: any[] = [], passedUserRole?: string, force = false) => {
    if (syncLock.current) return;
    
    // v291: Global throttle check (30s) to prevent loop on component remounts/refreshes
    const now_ts = Date.now();
    if (!force && (now_ts - lastBulkSyncAttempt < 30000)) {
      // console.log('[Sync] Bulk sync throttled (30s window)');
      return;
    }
    lastBulkSyncAttempt = now_ts;

    let projectsToProcess = [...initialProjects];
    
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return;
    }

    const u = session?.user as any;
    const userRole = (passedUserRole || u?.role || 'OPERATOR').toUpperCase();
    const isAdmin = ['ADMIN', 'ADMINISTRADOR', 'ADMINISTRADORA', 'SUPERADMIN', 'BOSS'].includes(userRole);
    
    const cacheKey = `projects_bulk_${u?.id || 'default'}`;
    
    if (!force) {
      const meta = await db.cacheMetadata.get(cacheKey);
      // v415: Reduced from 15 to 5 minutes for better reactivity in deleting projects/tasks
      const FRESHNESS_WINDOW = 5 * 60 * 1000;
      
      if (meta && (now_ts - meta.lastSync) < FRESHNESS_WINDOW) {
        // const minsLeft = Math.round((FRESHNESS_WINDOW - (now_ts - meta.lastSync)) / 60000);
        // console.log(`[Sync] Datos frescos para usuario ${u?.id}. Siguiente sync automático en ${minsLeft} min.`);
        return;
      }
    }

    // v291: We are actually starting a heavy sync now. Mark state.
    setIsBulkSyncing(true)
    await logSync('info', `Iniciando sincronización masiva (${userRole})...`, 'bulk-sync');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('bulk-cache-sync-started'));
    }

    setBulkProgress({ current: 0, total: 0 })
    syncLock.current = true;
    
    try {
      const u = session?.user as any;
      const userRole = (u?.role || 'OPERATOR').toUpperCase();
      const isAdmin = ['ADMIN', 'ADMINISTRADOR', 'ADMINISTRADORA', 'SUPERADMIN', 'BOSS'].includes(userRole);
      
      // v287: Preserve existing count to avoid UI flicker ("0 projects")
      const existingMeta = await db.cacheMetadata.get(cacheKey);
      await db.cacheMetadata.put({
        id: cacheKey,
        lastSync: existingMeta?.lastSync || Date.now(),
        count: existingMeta?.count || 0,
        status: 'syncing'
      });

      window.dispatchEvent(new CustomEvent('bulk-cache-sync-log', {
        detail: { message: `Iniciando sincronización optimizada (${userRole})...` }
      }))

      // 1. SYNC PROJECTS & CHATS (v416: Added timestamp to bypass CDN/Browser cache after deletion)
      const limit = 2000;
      const res = await fetch(`/api/projects/bulk-cache?limit=${limit}&_t=${Date.now()}`, { priority: 'low' })
      if (res.ok) {
        const fetchedProjects = await res.json()
        
        // v317: Even if backend filters, we apply local filter for UI consistency (fixes 30/30 vs 12 issue)
        if (!isAdmin) {
          const userId = Number(u?.id);
          projectsToProcess = fetchedProjects.filter((p: any) => {
            const isInTeam = p.team?.some((m: any) => Number(m.userId) === userId);
            const isCreator = Number(p.createdBy || p.createdById) === userId;
            return isInTeam || isCreator;
          });
        } else {
          projectsToProcess = fetchedProjects;
        }

        // v414: Limpieza de proyectos "huérfanos" en la caché local
        // Si un proyecto ya no viene del servidor (porque se borró) y no es un borrador offline (pending-), lo borramos de la caché.
        try {
          const fetchedIds = projectsToProcess.map((p: any) => p.id);
          const cachedProjects = await db.projectsCache.toArray();
          
          for (const cached of cachedProjects) {
            const isPending = typeof cached.id === 'string' && cached.id.startsWith('pending-');
            
            // v416: Comparación robusta para evitar fallos por tipo (string vs number)
            const existsOnServer = fetchedIds.some((fid: any) => 
              String(fid) === String(cached.id) || Number(fid) === Number(cached.id)
            );

            if (!existsOnServer && !isPending) {
              console.log(`[Sync] Borrando proyecto huérfano de la caché: ${cached.id}`);
              await db.projectsCache.delete(cached.id);
              // También borrar el chat asociado
              await db.chatCache.delete(cached.id);
            }
          }
        } catch (cleanupErr) {
          console.error('Error limpiando proyectos huérfanos:', cleanupErr);
        }

        
        const totalToSync = projectsToProcess.length
        const syncChannel = new BroadcastChannel('aquatech-sync');
        
        syncChannel.postMessage({ 
          type: 'DATA_SYNC_START', 
          total: totalToSync,
          isManual: force 
        });


        setBulkProgress({ current: 0, total: totalToSync })
        
        for (let i = 0; i < projectsToProcess.length; i++) {
          const p = projectsToProcess[i];
          const existing = await db.projectsCache.get(p.id);
          
          // v410: Intelligent merge — Preserve local optimistic changes if they are pending sync
          const mergedProject = {
            ...(existing || {}),
            ...p,
            // If the local project has a pending team sync, don't let the server's bulk data (which might be stale) overwrite our local team
            team: (existing?._pendingTeamSync && existing.team) ? existing.team : p.team,
            // Also preserve local gallery if a gallery upload is pending sync (though handled elsewhere, extra safety)
            gallery: (existing?._pendingGallerySync && existing.gallery) ? existing.gallery : p.gallery,
            isSkeleton: false,
            lastAccessedAt: Date.now()
          };
          
          await db.projectsCache.put(mergedProject);

          if (p.chatMessages && p.chatMessages.length > 0) {
            const existingChat = await db.chatCache.get(p.id);
            const existingMessages = existingChat?.messages || [];
            
            const messageMap = new Map();
            existingMessages.forEach((m: any) => messageMap.set(m.id, m));
            p.chatMessages.forEach((m: any) => messageMap.set(m.id, m));
            
            const finalMessages = Array.from(messageMap.values()).sort((a, b) => 
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            );

            await db.chatCache.put({ projectId: p.id, messages: finalMessages });
          }
          
          setBulkProgress(prev => ({ ...prev, current: i + 1 }));
          
          const syncChannel = new BroadcastChannel('aquatech-sync');
          syncChannel.postMessage({ 
            type: 'DATA_SYNC_PROGRESS', 
            current: i + 1, 
            total: totalToSync,
            projectName: p.title || p.id
          });
          syncChannel.close();

          window.dispatchEvent(new CustomEvent('bulk-cache-sync-progress', { 
            detail: { current: i + 1, total: totalToSync } 
          }));
        }

        // v287: Sync Appointments (Agenda/Tareas)
        window.dispatchEvent(new CustomEvent('bulk-cache-sync-log', {
          detail: { message: `Sincronizando agenda y tareas...` }
        }))
        
        try {
          const apptsRes = await fetch(`/api/appointments?userId=${u?.id}`)
          if (apptsRes.ok) {
            const appointments = await apptsRes.ok ? await apptsRes.json() : []
            if (Array.isArray(appointments)) {
              // v287: Clear and replace with fresh data for the user
              await db.appointmentsCache.clear()
              await db.appointmentsCache.bulkPut(appointments)
              // console.log(`[Sync] Cached ${appointments.length} appointments for user ${u?.id}`)
            }
          }
        } catch (e) {
          console.error('[Sync] Appointments sync failed:', e)
        }

        // v257: SAVE METADATA HERE (After data, before expensive pre-fetches)
        // This ensures that if the user closes the app during pre-fetching, 
        // we don't restart the whole process immediately next time.
        // v274: Removed premature metadata update. Now we only save at the very end.
        // v267: INTELLIGENT PRE-FETCHING — Sequential chunk-by-chunk, SW-aware
        // v267: Helper — waits up to 10s for the SW controller to be available
        const getController = async (): Promise<ServiceWorker | null> => {
          if (!('serviceWorker' in navigator)) return null;
          if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
          await navigator.serviceWorker.ready;
          for (let attempt = 0; attempt < 20; attempt++) {
            if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
            await new Promise(r => setTimeout(r, 500));
          }
          return navigator.serviceWorker.controller;
        };

        // v267: Sends a PRECACHE_URLS message and awaits SW confirmation via MessageChannel
        const precacheAndWait = async (urlOrUrls: string | string[], projectNameOrOptions: string | any = ''): Promise<void> => {
          const controller = await getController();
          const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
          const projectName = typeof projectNameOrOptions === 'string' ? projectNameOrOptions : '';
          const options = typeof projectNameOrOptions === 'object' ? projectNameOrOptions : {};
          
          if (!controller) {
            await Promise.all(urls.map(url => 
              fetch(url, { 
                credentials: 'same-origin', 
                headers: { 'Accept': 'text/html', ...options.headers } 
              }).catch(() => {})
            ));
            return;
          }
          await new Promise<void>((resolve) => {
            const { port1, port2 } = new MessageChannel();
            const timeout = setTimeout(() => resolve(), 30000);
            port1.onmessage = () => { clearTimeout(timeout); resolve(); };
            controller.postMessage({ type: 'PRECACHE_URLS', urls, projectName, options, replyPort: port2 }, [port2]);
          });
        };

        // v289: Shell-First Strategy — Only precache the 2 universal shells.
          // Individual project URLs are NOT needed because findCachedPage() in the SW
          // automatically serves the correct shell when the specific URL is missing.
          // This reduces sync from 3 minutes to ~15 seconds.
          window.dispatchEvent(new CustomEvent('bulk-cache-sync-log', {
            detail: { message: `Preparando entorno offline inteligente (Shell-First)...` }
          }))

          await Promise.all([
            precacheAndWait('/admin/proyectos/offline-shell', { headers: { 'Accept': 'text/html' } }),
            precacheAndWait('/admin/operador/proyecto/offline-shell', { headers: { 'Accept': 'text/html' } }),
            precacheAndWait('/admin/proyectos/offline-shell?_rsc=1'),
            precacheAndWait('/admin/operador/proyecto/offline-shell?_rsc=1'),
          ]);

          // 2. Main Sections (Role-Aware) — v280: All parallel, no delays
          const sections = isAdmin 
            ? ['/admin', '/admin/proyectos', '/admin/calendario', '/admin/inventario', '/admin/cotizaciones']
            : ['/admin/operador', '/admin/inventario', '/admin/cotizaciones'];

          await Promise.all(sections.map(async (section) => {
            await precacheAndWait(section);
            const rscUrl = section.includes('?') ? `${section}&_rsc=prefetch` : `${section}?_rsc=prefetch`;
            fetch(rscUrl, { priority: 'low', headers: { 'RSC': '1', 'Next-Router-Prefetch': '1' } }).catch(() => {});
          }));

          // 3. v user: Project-Specific Chunks — Pre-cache individual project details
          // For Admin: First 15 projects (same as list page)
          // For Operator: ALL projects (usually fewer, and they need them all offline)
          const projectsForChunks = isAdmin ? projectsToProcess.slice(0, 15) : projectsToProcess;
          
          if (projectsForChunks.length > 0) {
            window.dispatchEvent(new CustomEvent('bulk-cache-sync-log', {
              detail: { message: `Sincronizando activos de ${projectsForChunks.length} proyectos...` }
            }))

            const chunkSyncChannel = new BroadcastChannel('aquatech-sync');
            chunkSyncChannel.postMessage({ 
              type: 'ASSET_PRECACHE_PROGRESS', 
              current: 0, 
              total: projectsForChunks.length,
              active: true 
            });

            // Process in batches of 5 to avoid saturating the SW and network
            const BATCH_SIZE = 5;
            for (let i = 0; i < projectsForChunks.length; i += BATCH_SIZE) {
              const batch = projectsForChunks.slice(i, i + BATCH_SIZE);
              await Promise.all(batch.map(async (p, idx) => {
                const projectUrl = isAdmin ? `/admin/proyectos/${p.id}` : `/admin/operador/proyecto/${p.id}`;
                await precacheAndWait(projectUrl, p.title);
                
                // Update progress after each batch member finishes
                chunkSyncChannel.postMessage({ 
                  type: 'ASSET_PRECACHE_PROGRESS', 
                  current: Math.min(i + idx + 1, projectsForChunks.length), 
                  total: projectsForChunks.length,
                  active: true
                });
              }));
              // Tiny cooldown between batches
              await new Promise(r => setTimeout(r, 500));
            }
            
            chunkSyncChannel.postMessage({ type: 'ASSET_PRECACHE_FINISHED' });
            chunkSyncChannel.close();
          }
        }


      // 3. SYNC USERS — v281: Removed artificial 500ms delay
      window.dispatchEvent(new CustomEvent('bulk-cache-sync-log', {
        detail: { message: `Sincronizando equipo de trabajo...` }
      }))
      // v264: Fetch all relevant roles for offline selection
      // v274: Fetch ALL users (no role filter) so they are all available offline for assignments
      const userRes = await fetch('/api/users', { priority: 'low' })
      if (userRes.ok) {
        const users = await userRes.json()
        if (Array.isArray(users)) {
           await db.usersCache.clear();
           await db.usersCache.bulkPut(users.map(u => ({
             id: u.id,
             name: u.name,
             role: u.role
           })));
        }
      }

      // 4. SYNC QUOTES
      if (isAdmin) {
        await new Promise(resolve => setTimeout(resolve, 500));
        window.dispatchEvent(new CustomEvent('bulk-cache-sync-log', {
          detail: { message: `Sincronizando cotizaciones...` }
        }))
        const quoteRes = await fetch('/api/quotes?limit=100', { priority: 'low' })
        if (quoteRes.ok) {
          const quotes = await quoteRes.json()
          await db.quotesCache.bulkPut(quotes);
        }
      }

      const now = Date.now()
      const finalCount = projectsToProcess.length;
      
      // v316: Ensure SW is aware of the exact projects to precache BEFORE we tell the UI we are done.
      // This solves the race condition where UI turns green prematurely.
      if (navigator.serviceWorker?.controller) {
        const urls = projectsToProcess.slice(0, 15).map(p => 
          isAdmin ? `/admin/proyectos/${p.id}` : `/admin/operador/proyecto/${p.id}`
        );
        navigator.serviceWorker.controller.postMessage({
          type: 'PRECACHE_URLS',
          urls
        });
      }

      const cacheKeyFinal = `projects_bulk_${u?.id || 'default'}`;
      await db.cacheMetadata.put({
        id: cacheKeyFinal,
        lastSync: now,
        count: finalCount,
        status: 'idle'
      })
      
      await logSync('success', `Sincronización masiva completada: ${finalCount} proyectos`, 'bulk-sync');

      const syncChannelFinal = new BroadcastChannel('aquatech-sync');
      syncChannelFinal.postMessage({ type: 'DATA_SYNC_FINISHED', count: finalCount });
      syncChannelFinal.close();

      window.dispatchEvent(new CustomEvent('bulk-cache-sync-finished', { 
        detail: { count: finalCount } 
      }))

      // 5. SILENT GARBAGE COLLECTION (v278)
      // Keeps the local database small by removing stale projects if we exceed 60
      try {
        // v288: Increased from 60 to 500 to allow full offline operation
        const MAX_KEPT_PROJECTS = 500;
        const allCachedProjects = await db.projectsCache.orderBy('lastAccessedAt').reverse().toArray();
        if (allCachedProjects.length > MAX_KEPT_PROJECTS) {
          const toDelete = allCachedProjects.slice(MAX_KEPT_PROJECTS).map(p => p.id);
          if (toDelete.length > 0) {
            await db.projectsCache.bulkDelete(toDelete);
            await db.chatCache.bulkDelete(toDelete);
            // console.log(`[GarbageCollector] Limpiados ${toDelete.length} proyectos antiguos de la caché local.`);
          }
        }
      } catch (gcErr) {
        console.warn('Error en la barredora de caché:', gcErr);
      }

      // 6. ORPHAN CLEANUP — Remove from local cache any project that no longer
      // exists on the server (e.g. deleted by an admin).
      // Only runs when the server returned a valid, non-empty list so we never
      // accidentally wipe the cache due to a failed fetch.
      if (projectsToProcess.length > 0) {
        try {
          const serverIds = new Set(projectsToProcess.map((p: any) => p.id));
          const allCached = await db.projectsCache.toArray();
          const orphanIds = allCached
            .filter(p => !serverIds.has(p.id))
            .map(p => p.id);
          if (orphanIds.length > 0) {
            await db.projectsCache.bulkDelete(orphanIds);
            await db.chatCache.bulkDelete(orphanIds);
            await logSync(
              'info',
              `Orphan cleanup: ${orphanIds.length} proyectos borrados de caché local (ya no existen en servidor)`,
              'bulk-sync'
            );
          }
        } catch (orphanErr) {
          console.warn('[Sync] Orphan cleanup falló (no crítico):', orphanErr);
        }
      }
    } catch (err) {
      console.error('Skeleton sync error:', err)
      await logSync('error', `Fallo sincronización masiva: ${err instanceof Error ? err.message : 'Desconocido'}`, 'bulk-sync');
      window.dispatchEvent(new CustomEvent('bulk-cache-sync-log', {
        detail: { message: `Error en sincronización: ${err instanceof Error ? err.message : 'Desconocido'}` }
      }))
      
      // v291: Reset status to idle on failure so we don't get stuck in "syncing" state
      try {
        const u = session?.user as any;
        const cacheKey = `projects_bulk_${u?.id || 'default'}`;
        const existing = await db.cacheMetadata.get(cacheKey);
        if (existing) {
          await db.cacheMetadata.update(cacheKey, { status: 'idle' });
        }
      } catch (metaErr) {}
    } finally {
      syncLock.current = false;
      setIsBulkSyncing(false)
    }
  }

  useEffect(() => {
    if (session?.user?.id && navigator.onLine) {
      const u = session.user
      const authData = {
        userId: u.id,
        name: u.name || '',
        role: (u.role as any) || 'OPERATOR',
        username: (u as any).username || '',
        permissions: (u as any).permissions || null,
        lastLogin: Date.now()
      }
      
      db.auth.put({ ...authData, id: 'last_session' }).catch(console.error)
      db.authShadow.put({ ...authData, id: 'current' }).catch(console.error)
    }
  }, [session])
  
  const syncOutbox = async () => {
    if (typeof window === 'undefined' || !navigator.onLine || outboxLock.current) return
    
    // v471: Si es nativo (Capacitor), delegar 100% de la sincronización de la outbox al servicio nativo Kotlin
    try {
      const { isNative } = await import('@/lib/native-bridge');
      if (isNative()) {
        // console.log('[Sync] Plataforma nativa detectada. Delegando sincronización a Kotlin Foreground Service.');
        return;
      }
    } catch (e) {}
    
    // v446: Reset stuck 'syncing' items — use primaryKeys to avoid OOM
    try {
      const stuckIds = await db.outbox.where('status').equals('syncing').primaryKeys();
      const now = Date.now();
      for (const id of stuckIds) {
        const item = await db.outbox.get(id);
        if (!item) continue;

        // Only reset if lastAttemptAt is set (item was actually claimed for processing)
        if (!item.lastAttemptAt) {
          await db.outbox.update(item.id!, { status: 'pending' });
          continue;
        }
        
        const stuckTime = now - item.lastAttemptAt;
        const stuckPayloadSize = item.payload?.sizeBytes || item.payload?.file?.size || 0;
        // v440: Dynamic stuck threshold — scale with file size
        // Formula: max(120s, 5s per MB). A 300MB video: max(120, 1500) = 25 min.
        const stuckThresholdMs = Math.max(120000, Math.ceil(stuckPayloadSize / (1024 * 1024)) * 5000);
        
        if (stuckTime > stuckThresholdMs) {
          console.warn(`[Sync] Resetting stuck item ${item.id} (${item.type}) after ${(stuckTime/1000).toFixed(0)}s`);
          await db.outbox.update(item.id!, { status: 'pending' });
        }
      }
    } catch (e) { /* ignore */ }

    // Cross-tab and remount lock
    const now = Date.now()
    if (now - lastSyncExecution < 1500) {
      // v400: Reduced throttle to 1.5s for faster sync pickup
      return
    }

    const isGreedy = (window as any)._syncGreedy === true;
    const lastSyncStart = localStorage.getItem('global_sync_lock')
    if (!isGreedy && lastSyncStart && (now - Number(lastSyncStart)) < 8000) {
      // v282: Reduced cross-tab lock from 30s to 8s so items flow continuously
      return
    }
    localStorage.setItem('global_sync_lock', String(now))
    lastSyncExecution = now;

    outboxLock.current = true;
    let hasSyncedAnything = false;
    try {
      // v445: CRITICAL MEMORY OPTIMIZATION — Avoid .toArray() (OOM RISK).
      // Large video files in the outbox can crash the browser if loaded all at once.
      // We get IDs in order and process them one-by-one to keep memory usage low.
      const allIds = await db.outbox.orderBy('timestamp').primaryKeys();
      
      if (allIds.length === 0) {
        localStorage.removeItem('global_sync_lock')
        return
      }

      hasSyncedAnything = false;
      const failedContexts = new Set<string>();
      const syncingContexts = new Set<string>();

      // Pass 1: Identify contexts that are currently syncing (to preserve FIFO order)
      for (const id of allIds) {
        const item = await db.outbox.get(id);
        if (!item) continue;
        if (item.status === 'syncing') {
          const ctx = item.projectId ? `proj-${item.projectId}` : (item.type === 'DAY_START' || item.type === 'DAY_END' ? 'day-record' : null);
          if (ctx) syncingContexts.add(ctx);
        }
      }

      // Pass 1.5: CONTINUOUS CONCURRENT GALLERY SYNC — v450 Optimized
      // Instead of rigid batches of 3 where everyone waits for the slowest file,
      // we use a sliding window. As soon as one upload finishes, the next one starts.
      const pendingGalleryIds: number[] = [];
      for (const id of allIds) {
        const item = await db.outbox.get(id);
        if (item && item.type === 'GALLERY_UPLOAD' && item.status === 'pending') {
          pendingGalleryIds.push(id);
        }
      }
      
      if (pendingGalleryIds.length > 0) {
        console.log(`[Sync] 🚀 Continuous sync for ${pendingGalleryIds.length} gallery items...`);
        const { uploadToBunnyClientSide } = await import('@/lib/storage-client');
        const MAX_CONCURRENCY = 3;
        const activeUploads = new Set();
        
        // Internal worker to process a single item end-to-end
        const processItem = async (id: number) => {
          const gItem = await db.outbox.get(id);
          if (!gItem || gItem.status !== 'pending') return;
          
          await db.outbox.update(id, { status: 'syncing', lastAttemptAt: Date.now() });
          const p = gItem.payload || {};
          
          try {
            // Step 1: Upload to Bunny
            let uploadFile: File | Blob | null = null;
            let uploadFilename = p.filename || `gallery_${Date.now()}`;
            
            if (p.fileData?.buffer) {
              uploadFile = new Blob([p.fileData.buffer], { type: p.fileData.type || p.mimeType || 'application/octet-stream' });
              uploadFilename = p.fileData.name || uploadFilename;
            } else if (p.file instanceof File || p.file instanceof Blob) {
              uploadFile = p.file as File | Blob;
              uploadFilename = (p.file as File).name || uploadFilename;
            } else if (p.cacheKey) {
              const { getFileFromCache } = await import('@/lib/offline-utils');
              const cached = await getFileFromCache(p.cacheKey);
              if (cached && cached.size > 0) uploadFile = cached;
            } else if (p.url?.startsWith('data:')) {
              const res = await fetch(p.url);
              uploadFile = await res.blob();
            }
            
            if (!uploadFile || uploadFile.size === 0) throw new Error('No file data');
            
            console.log(`[Sync] 📤 Uploading: ${uploadFilename} (${(uploadFile.size/1024/1024).toFixed(1)}MB)...`);
            const uploadResult = await uploadToBunnyClientSide(uploadFile, uploadFilename, `projects/${gItem.projectId}/gallery`);
            
            // Step 2: Immediate API POST
            const finalPayload = { ...p, url: uploadResult.url, mimeType: uploadResult.mimeType || (uploadFile as any).type };
            delete finalPayload.file; delete finalPayload.fileData; delete finalPayload.cacheKey; delete finalPayload.base64;
            
            const res = await fetch(`/api/projects/${gItem.projectId}/gallery`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-sync-id': gItem.syncId || `sync-${id}-${gItem.timestamp}` },
              body: JSON.stringify({ ...finalPayload, isOfflineSync: true }),
            });
            
            if (res.ok) {
              const resData = await res.json().catch(() => ({}));
              
              // v451: Update projectsCache gallery so it's authoritative immediately
              try {
                let numericId = Number(gItem.projectId);
                if (isNaN(numericId) && String(gItem.projectId).startsWith('pending-')) {
                  numericId = Number(String(gItem.projectId).replace('pending-', ''));
                }
                if (!isNaN(numericId) && resData && resData.id) {
                  const proj = await db.projectsCache.get(numericId);
                  if (proj) {
                    const newGallery = proj.gallery ? [...proj.gallery] : [];
                    if (!newGallery.some((g: any) => g.id === resData.id)) {
                      newGallery.push(resData);
                      newGallery.sort((a, b) => new Date(b.createdAt || Date.now()).getTime() - new Date(a.createdAt || Date.now()).getTime());
                      await db.projectsCache.update(numericId, { gallery: newGallery });
                    }
                  }
                }
              } catch (cacheErr) {
                console.warn('[Sync] Cache update failed for gallery item:', cacheErr);
              }

              // v451: DELETE from outbox. Staying in outbox (even as 'synced') causes UI duplication.
              await db.outbox.delete(id);
              
              console.log(`[Sync] ✅ Gallery OK: ${uploadFilename}`);
              await logSync('success', `Galería: ${uploadFilename}`, 'GALLERY_UPLOAD');
              window.dispatchEvent(new CustomEvent('sync-success', { detail: {
                type: 'GALLERY_UPLOAD', projectId: gItem.projectId, label: 'Archivo subido', payload: finalPayload, result: resData
              }}));
              hasSyncedAnything = true;
            } else {
              throw new Error(`API Error ${res.status}`);
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[Sync] ❌ Gallery FAIL #${id}:`, errMsg);
            const currentAttempts = (gItem.attempts || 0) + 1;
            await db.outbox.update(id, {
              status: currentAttempts >= 15 ? 'failed' : 'pending',
              attempts: currentAttempts,
              lastAttemptAt: Date.now(),
              failReason: errMsg.substring(0, 150)
            });
          }
        };

        // Pipelined loop
        for (const id of pendingGalleryIds) {
          if (activeUploads.size >= MAX_CONCURRENCY) {
            await Promise.race(activeUploads);
          }
          const task = (async () => {
            const item = await db.outbox.get(id);
            const filename = item?.payload?.filename || 'archivo';
            setUploadProgress({ filename, percent: 10, chunk: 1, totalChunks: 1 });
            await processItem(id);
            setUploadProgress({ filename, percent: 100, chunk: 1, totalChunks: 1 });
          })().then(() => {
            activeUploads.delete(task);
            if (activeUploads.size === 0) setTimeout(() => setUploadProgress(null), 2000);
          });
          activeUploads.add(task);
        }
        await Promise.all(activeUploads);
      }

      // Pass 2: Main processing loop (non-GALLERY items only)
      for (const id of allIds) {
        const item = await db.outbox.get(id);
        if (!item || item.status === 'synced' || item.status === 'syncing') continue;

        const ctx = item.projectId ? `proj-${item.projectId}` : (item.type === 'DAY_START' || item.type === 'DAY_END' ? 'day-record' : null);
        
        // v369/v445: Preserves strictly chronological order per context (Project, DayRecord, etc.)
        if (ctx && (failedContexts.has(ctx) || syncingContexts.has(ctx))) {
          continue;
        }

        // We use the freshly fetched item as 'currentItem'
        const currentItem = item;


        // v443: Cooldown logic - prevent infinite retries without blocking too long.
        // Attempts 1-7: retry every 10s (normal cooldown via lastAttemptAt check below)
        // Attempts 8-9: 2 min cooldown (conservative, something is clearly wrong)
        // Attempt 10+: permanently failed (handled in catch block)
        const attempts = currentItem.attempts || 0;
        if (attempts >= 8) {
          const minsSinceLastAttempt = (Date.now() - (currentItem.lastAttemptAt || currentItem.timestamp || 0)) / 60000;
          if (minsSinceLastAttempt < 2) {
            continue;
          }
          // v373: After 8+ attempts for media uploads, validate that file data still exists.
          const isMediaType = currentItem.type === 'GALLERY_UPLOAD' || currentItem.type === 'MEDIA_UPLOAD';
          if (isMediaType) {
            const p = currentItem.payload || {};
            const hasValidData = !!(p.fileData || p.file || p.cacheKey || p.media?.fileData || p.media?.base64 || 
              (p.url && !p.url.startsWith('blob:') && !p.url.startsWith('data:') && p.url.startsWith('http')) ||
              (p.media?.url && !p.media.url.startsWith('blob:') && p.media.url.startsWith('http')));
            if (!hasValidData) {
              console.warn(`[Sync] Permanently failing media item ${item.id} - file data lost after ${attempts} attempts`);
              await db.outbox.update(item.id!, { status: 'failed', failReason: 'FILE_DATA_LOST' });
              await logSync('error', `Descartado: ${item.type} #${item.id} - datos del archivo perdidos`, item.type);
              continue;
            }
          }
        }

        try {
          await db.outbox.update(item.id!, { status: 'syncing', lastAttemptAt: Date.now() })
          let endpoint = ''
          let method = 'POST'
          
          if (item.type === 'QUOTE') { endpoint = '/api/quotes' }
          else if (item.type === 'MATERIAL') { endpoint = '/api/materials' }
          else if (item.type === 'MESSAGE' || item.type === 'MEDIA_UPLOAD' || item.type === 'LOCATION') { endpoint = `/api/projects/${item.projectId}/messages` }
          else if (item.type === 'EXPENSE') { 
            if (item.payload.id) {
              endpoint = `/api/projects/${item.projectId}/expenses/${item.payload.id}`;
              method = 'PATCH';
            } else {
              endpoint = `/api/projects/${item.projectId}/expenses`;
              method = 'POST';
            }
          }
          else if (item.type === 'EXPENSE_DELETE') {
            endpoint = `/api/projects/${item.projectId}/expenses/${item.payload.expenseId}`;
            method = 'DELETE';
          }
          else if (item.type === 'DAY_START') { endpoint = `/api/day-records` }
          else if (item.type === 'DAY_END') { endpoint = `/api/day-records`; method = 'PUT' }
          else if (item.type === 'PHASE_COMPLETE' || item.type === 'PHASE_UPDATE') { 
            endpoint = `/api/projects/${item.projectId}/phases/${item.payload.phaseId}`; 
            method = 'PATCH' 
          }
          else if (item.type === 'PHASE_CREATE') {
            endpoint = `/api/projects/${item.projectId}/phases`;
            method = 'POST'
          }
          else if (item.type === 'PROJECT') { endpoint = '/api/projects' }
          else if (item.type === 'PROJECT_UPDATE') { endpoint = `/api/projects/${item.projectId}`; method = 'PATCH' }
          else if (item.type === 'TEAM_UPDATE') { endpoint = `/api/projects/${item.projectId}/team`; method = 'PUT' }
          else if (item.type === 'TASK') {
            if (!item.payload.isNew && (item.payload.id || item.payload._id)) {
              endpoint = `/api/appointments/${item.payload.id || item.payload._id}`
              method = 'PATCH'
            } else {
              endpoint = '/api/appointments'
            }
          }
          else if (item.type === 'TASK_STATUS_TOGGLE') { endpoint = `/api/appointments/${item.payload.appointmentId}`; method = 'PATCH' }
          else if (item.type === 'GALLERY_UPLOAD') { endpoint = `/api/projects/${item.projectId}/gallery` }
          else if (item.type === 'GALLERY_DELETE') { endpoint = `/api/projects/${item.projectId}/gallery/${item.payload.galleryId}`; method = 'DELETE' }
          else if (item.type === 'GALLERY_RENAME') { 
            endpoint = `/api/projects/${item.projectId}/gallery/${item.payload.galleryId}`; 
            method = 'PATCH' 
          }
          
          let finalPayload = { ...item.payload }
          
          // --- NEW: UNIFIED MEDIA SYNC LOGIC ---
          const { uploadToBunnyClientSide } = await import('@/lib/storage-client')
          
          // v444: DIAGNOSTIC — log what data each GALLERY_UPLOAD item has
          if (item.type === 'GALLERY_UPLOAD') {
            console.log(`[Sync] GALLERY item #${item.id} diagnosis:`, {
              hasCacheKey: !!finalPayload.cacheKey,
              cacheKey: finalPayload.cacheKey || 'NONE',
              hasFileData: !!finalPayload.fileData,
              hasFile: !!finalPayload.file,
              fileSize: finalPayload.file?.size || 0,
              url: (finalPayload.url || '').substring(0, 50) || 'EMPTY',
              filename: finalPayload.filename || 'NONE',
              mimeType: finalPayload.mimeType || 'NONE',
              storageType: finalPayload.storageType || 'NONE',
              attempts: item.attempts || 0
            });
          }
          
          // Variable declarations for generic media handler (MESSAGE, MEDIA_UPLOAD, EXPENSE)
          const rawFileObj = finalPayload.file;
          const hasRawFile = !!(rawFileObj && typeof rawFileObj === 'object' && 
            typeof rawFileObj.size === 'number' && rawFileObj.size > 0 &&
            typeof rawFileObj.slice === 'function');
          const hasBinaryData = !!(
            (finalPayload.fileData && finalPayload.fileData.buffer) ||
            (finalPayload.media?.fileData && finalPayload.media.fileData.buffer) ||
            finalPayload.receiptFileData
          );
          const hasCacheKey = !!(finalPayload.cacheKey);
          const hasBase64 = !!(finalPayload.media?.base64 || 
                            finalPayload.receiptPhoto?.startsWith('data:'));
          const hasBlobUrl = !hasRawFile && !hasBinaryData && !hasCacheKey && !!((typeof finalPayload.media?.url === 'string' && finalPayload.media.url.startsWith('blob:')) ||
                             (typeof finalPayload.url === 'string' && finalPayload.url.startsWith('blob:')) ||
                             (typeof finalPayload.receiptPhoto === 'string' && finalPayload.receiptPhoto.startsWith('blob:')));

          // vXXX: GALLERY_UPLOAD — COPIA EXACTA del handler PROJECT (el que SÍ funciona)
          // Misma lógica, mismas verificaciones, mismos fallbacks.
          if (item.type === 'GALLERY_UPLOAD') {
            let galleryUploadDone = false;
            try {
              let uploadFile: File | Blob | null = null;
              let uploadFilename = finalPayload.filename || `gallery_${Date.now()}`;

              // ── PRIORIDAD 0: fileData.buffer (ArrayBuffer) ──
              // IDÉNTICO a PROJECT line 1094-1101
              if (finalPayload.fileData && finalPayload.fileData.buffer) {
                uploadFile = new Blob([finalPayload.fileData.buffer], { 
                  type: finalPayload.fileData.type || finalPayload.mimeType || 'application/octet-stream' 
                });
                uploadFilename = finalPayload.fileData.name || uploadFilename;
                console.log(`[Sync] GALLERY ✅ ArrayBuffer: ${uploadFilename} (${(uploadFile.size/1024/1024).toFixed(1)}MB)`);
              }
              // ── PRIORIDAD 1: raw File/Blob (instanceof) ──
              // IDÉNTICO a PROJECT line 1081: (f.file instanceof File || f.file instanceof Blob)
              else if (finalPayload.file instanceof File || finalPayload.file instanceof Blob) {
                uploadFile = finalPayload.file as File | Blob;
                uploadFilename = (finalPayload.file as File).name || uploadFilename;
                console.log(`[Sync] GALLERY ✅ File/Blob (instanceof): ${uploadFilename} (${(uploadFile.size/1024/1024).toFixed(1)}MB)`);
              }
              // ── PRIORIDAD 2: duck-typing fallback ──
              // Cubre el caso donde IndexedDB structured clone NO preserva el prototype chain
              // (pasa en algunos Android WebView: el objeto tiene .size y .slice pero NO es instanceof File/Blob)
              else if (finalPayload.file && typeof finalPayload.file === 'object' && 
                       typeof finalPayload.file.size === 'number' && finalPayload.file.size > 0) {
                // Intentar reconstruir un Blob a partir de lo que tengamos
                const raw = finalPayload.file;
                console.warn(`[Sync] GALLERY ⚠️ File perdió prototype (size=${raw.size}). Reconstruyendo Blob...`);
                try {
                  // Si tiene stream/slice, es un Blob degradado
                  uploadFile = raw as Blob;
                  uploadFilename = (raw as any).name || uploadFilename;
                } catch {
                  // Último intento: crear Blob desde arrayBuffer si existe en fileData
                  if (finalPayload.fileData?.buffer) {
                    uploadFile = new Blob([finalPayload.fileData.buffer], { type: finalPayload.mimeType || 'application/octet-stream' });
                  }
                }
                if (uploadFile && uploadFile.size > 0) {
                  console.log(`[Sync] GALLERY ✅ Duck-typing Blob: ${uploadFilename} (${(uploadFile.size/1024/1024).toFixed(1)}MB)`);
                }
              }
              // ── PRIORIDAD 3: Cache API (ítems viejos) ──
              else if (finalPayload.cacheKey) {
                const { getFileFromCache } = await import('@/lib/offline-utils');
                const cached = await getFileFromCache(finalPayload.cacheKey);
                if (cached && cached.size > 0) {
                  uploadFile = cached;
                  console.log(`[Sync] GALLERY ⚠️ Cache API (legacy): ${uploadFilename} (${(cached.size/1024/1024).toFixed(1)}MB)`);
                }
              }
              // ── PRIORIDAD 4: base64/data URL (ítems viejos pequeños) ──
              else if (finalPayload.url && finalPayload.url.startsWith('data:')) {
                const res = await fetch(finalPayload.url);
                uploadFile = await res.blob();
                console.log(`[Sync] GALLERY ⚠️ base64 (legacy): ${uploadFilename} (${(uploadFile.size/1024/1024).toFixed(1)}MB)`);
              }

              // ── SUBIR A BUNNY (mismo código que PROJECT line 1095/1105) ──
              if (uploadFile && uploadFile.size > 0) {
                const folder = `projects/${item.projectId}`;
                setUploadProgress({ filename: uploadFilename, percent: 50, chunk: 1, totalChunks: 1 });
                const uploadResult = await uploadToBunnyClientSide(uploadFile, uploadFilename, folder);
                setUploadProgress({ filename: uploadFilename, percent: 100, chunk: 1, totalChunks: 1 });
                setTimeout(() => setUploadProgress(null), 2000);

                finalPayload.url = uploadResult.url;
                finalPayload.mimeType = uploadResult.mimeType || (uploadFile as any).type;
                delete finalPayload.file;
                delete finalPayload.fileData;
                delete finalPayload.base64;
                if (finalPayload.cacheKey) {
                  try { const { deleteFileFromCache } = await import('@/lib/offline-utils'); await deleteFileFromCache(finalPayload.cacheKey); } catch {}
                  delete finalPayload.cacheKey;
                }
                galleryUploadDone = true;
                console.log(`[Sync] GALLERY 🎉 upload OK: ${uploadResult.url}`);
              } else {
                // Diagnóstico completo de por qué no se encontraron datos
                const diag = {
                  hasFileData: !!finalPayload.fileData,
                  hasBuffer: !!(finalPayload.fileData?.buffer),
                  bufferSize: finalPayload.fileData?.buffer?.byteLength || 0,
                  hasFile: !!finalPayload.file,
                  fileType: typeof finalPayload.file,
                  fileSize: finalPayload.file?.size || 0,
                  isFile: finalPayload.file instanceof File,
                  isBlob: finalPayload.file instanceof Blob,
                  hasCacheKey: !!finalPayload.cacheKey,
                  urlPreview: (finalPayload.url || '').substring(0, 40),
                  mimeType: finalPayload.mimeType,
                  filename: finalPayload.filename,
                  attempts: item.attempts || 0
                };
                console.error(`[Sync] GALLERY ❌ #${item.id}: SIN DATOS. Diagnóstico:`, diag);
                await db.outbox.update(item.id!, { status: 'failed', failReason: `FILE_DATA_LOST:${JSON.stringify(diag)}` });
                await logSync('error', `Descartado: GALLERY #${item.id} sin datos (${finalPayload.filename || '?'})`, item.type);
                continue;
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.error(`[Sync] GALLERY ❌ ERROR #${item.id}:`, errMsg, err);
              const currentAttempts = (item.attempts || 0) + 1;
              await db.outbox.update(item.id!, { 
                status: currentAttempts >= 15 ? 'failed' : 'pending',
                attempts: currentAttempts,
                lastAttemptAt: Date.now(),
                failReason: `upload_err_${currentAttempts}: ${errMsg.substring(0, 200)}`
              });
              continue;
            }
            // Skip the generic media handler — gallery is already handled
          }

          // 1. Handle single media (MESSAGE, MEDIA_UPLOAD, EXPENSE — NOT GALLERY_UPLOAD anymore)
          // v452: GALLERY_UPLOAD now has its own dedicated handler above (same pattern as PROJECT)
          if (item.type !== 'GALLERY_UPLOAD' && (hasRawFile || hasBinaryData || hasCacheKey || hasBase64 || hasBlobUrl)) {
            try {
              let uploadFile: File | Blob;
              let finalFilename: string = '';

              // v445: PRIORITY 0 — Native File/Blob (Most reliable, zero-copy retrieval from IndexedDB)
              if (hasRawFile) {
                uploadFile = rawFileObj as Blob;
                finalFilename = rawFileObj.name || finalPayload.filename || `sync_${Date.now()}`;
                console.log(`[Sync] Using native File: ${finalFilename} (${(uploadFile.size/1024/1024).toFixed(1)}MB)`);
              }
              // PRIORITY 1 — ArrayBuffer (legacy projects or small files)
              else if (hasBinaryData) {
                const source = finalPayload.fileData || finalPayload.media?.fileData || finalPayload.receiptFileData;
                if (source && source.buffer) {
                  uploadFile = new Blob([source.buffer], { type: source.type || 'application/octet-stream' });
                  finalFilename = source.name || finalPayload.filename || `sync_${Date.now()}`;
                } else if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
                  uploadFile = new Blob([source as any], { type: finalPayload.mimeType || 'application/octet-stream' });
                  finalFilename = finalPayload.filename || `sync_${Date.now()}`;
                } else {
                  throw new Error('fileData exists but has no valid buffer');
                }
                console.log(`[Sync] Using ArrayBuffer: ${finalFilename} (${(uploadFile.size/1024/1024).toFixed(1)}MB)`);
              }
              // PRIORITY 2 — Cache API (v444 items only)
              else if (hasCacheKey) {
                const { getFileFromCache } = await import('@/lib/offline-utils');
                const cached = await getFileFromCache(finalPayload.cacheKey);
                if (!cached || cached.size === 0) {
                  console.error(`[Sync] Cache API: file not found for key ${finalPayload.cacheKey}`);
                  await db.outbox.update(item.id!, { status: 'failed', failReason: 'FILE_DATA_LOST' });
                  await logSync('error', `Cache perdido: ${item.type} #${item.id}`, item.type);
                  continue;
                }
                uploadFile = cached;
                finalFilename = finalPayload.filename || `sync_${Date.now()}`;
                console.log(`[Sync] Using Cache API fallback: ${finalFilename} (${(cached.size/1024/1024).toFixed(1)}MB)`);
              }
              // PRIORITY 3 — base64 or blob URL
              else {
                const source = finalPayload.media?.base64 || 
                               finalPayload.media?.url || 
                               finalPayload.url || 
                               finalPayload.receiptPhoto;
                
                try {
                  const resB64 = await fetch(source as string);
                  uploadFile = await resB64.blob();
                  console.log(`[Sync] Using fetched source: ${(uploadFile.size/1024/1024).toFixed(1)}MB`);
                } catch (fetchErr) {
                  const sourceStr = String(source || '').slice(0, 50);
                  console.error(`[Sync] Cannot fetch media source: ${sourceStr}`, fetchErr);
                  if (typeof source === 'string' && source.startsWith('blob:')) {
                    await db.outbox.update(item.id!, { status: 'failed', failReason: 'FILE_DATA_LOST' });
                    continue;
                  }
                  throw fetchErr;
                }
              }
              
              if (!finalFilename) {
                finalFilename = finalPayload.media?.filename || 
                                finalPayload.media?.fileName || 
                                finalPayload.fileData?.name ||
                                finalPayload.filename || 
                                `sync_${Date.now()}.jpg`;
              }

              const folder = item.projectId ? `projects/${item.projectId}` : 'general';

              // v449: Revert to direct PUT upload matching PROJECT creation logic
              console.log(`[Sync] Direct PUT upload: ${finalFilename} (${(uploadFile.size/1024/1024).toFixed(1)}MB)`);
              setUploadProgress({ filename: finalFilename, percent: 50, chunk: 1, totalChunks: 1 });
              const uploadResult = await uploadToBunnyClientSide(uploadFile, finalFilename, folder);
              setUploadProgress({ filename: finalFilename, percent: 100, chunk: 1, totalChunks: 1 });
              setTimeout(() => setUploadProgress(null), 2000);
              
              if (item.type === 'EXPENSE') {
                finalPayload.receiptPhoto = uploadResult.url;
                if (finalPayload.receiptFileData) finalPayload.receiptFileData = null; 
              } else {
                finalPayload.media = { 
                  ...finalPayload.media,
                  url: uploadResult.url, 
                  filename: finalFilename, 
                  mimeType: uploadResult.mimeType || uploadFile.type,
                  type: uploadResult.type,
                  base64: undefined,
                  fileData: null
                };
              }
              
              // v442: pause between uploads
              await new Promise(resolve => setTimeout(resolve, 300));
              delete finalPayload.file;
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.error(`[Sync] UPLOAD ERROR ${item.type} #${item.id}:`, errMsg);
              const currentAttempts = (item.attempts || 0) + 1;
              
              // v446: More conservative failure for media (up to 15 attempts if using chunks)
              const maxAttempts = (item.type === 'MEDIA_UPLOAD') ? 15 : 10;
              
              await db.outbox.update(item.id!, { 
                status: currentAttempts >= maxAttempts ? 'failed' : 'pending',
                attempts: currentAttempts,
                lastAttemptAt: Date.now(),
                failReason: `upload_err_${currentAttempts}: ${errMsg.substring(0, 150)}`
              });
              if (ctx && item.type !== 'MEDIA_UPLOAD') {
                failedContexts.add(ctx);
              }
              await logSync('warn', `UPLOAD ERROR: ${errMsg.substring(0, 80)}`, item.type);
              continue;
            }
          }

          // 2. Handle multiple media (TASK / CALENDAR)
          if (item.type === 'TASK' && (finalPayload.attachments || finalPayload.attachmentLinks || finalPayload.files)) {
            try {
              // v360: Robust deduplication — prioritize binary sources (fileData) > base64 > url
              const rawSources = [
                ...(finalPayload.attachments || []), 
                ...(finalPayload.attachmentLinks || []),
                ...(finalPayload.files || [])
              ];
              
              const sourceMap = new Map<string, any>();
              for (const att of rawSources) {
                if (!att.name) continue;
                const existing = sourceMap.get(att.name);
                
                // Score source quality
                const getScore = (a: any) => {
                  const src = a.fileData || a.data || a.base64 || a.url || '';
                  if (a.fileData || (typeof src === 'object' && src.buffer)) return 3;
                  if (typeof src === 'string' && src.startsWith('data:')) return 2;
                  if (typeof src === 'string' && src.startsWith('blob:')) return 1;
                  if (typeof src === 'string' && src.startsWith('http')) return 0;
                  return -1;
                };

                if (!existing || getScore(att) > getScore(existing)) {
                  sourceMap.set(att.name, att);
                }
              }

              const uniqueSources = Array.from(sourceMap.values());
              const uploadedFiles = [];

              for (const att of uniqueSources) {
                const sourceData = att.fileData || att.data || att.base64 || att.url;
                if (!sourceData) continue;

                let finalUrl = '';
                // v443: Robust detection for binary/blob data
                const isBlob = sourceData instanceof Blob;
                const isArrayBuffer = sourceData instanceof ArrayBuffer || (sourceData && typeof sourceData === 'object' && 'byteLength' in sourceData);
                const isBase64 = typeof sourceData === 'string' && sourceData.startsWith('data:');
                const isBlobUrl = typeof sourceData === 'string' && sourceData.startsWith('blob:');

                if (isBlob || isArrayBuffer || isBase64 || isBlobUrl) {
                  let blob: Blob;
                  if (isBlob) {
                    blob = sourceData as Blob;
                  } else if (isArrayBuffer) {
                    blob = new Blob([sourceData as any], { type: att.type || 'application/octet-stream' });
                  } else {
                    const res = await fetch(sourceData as string);
                    blob = await res.blob();
                  }
                  
                  // Use standardized upload with long timeout
                  const uploadResult = await uploadToBunnyClientSide(blob, att.name, 'appointments');
                  finalUrl = uploadResult.url;
                  
                  // Release memory immediately
                  if (att.fileData) att.fileData = null;
                  if (att.data) att.data = null;
                  if (att.base64) att.base64 = null;
                  
                  await new Promise(resolve => setTimeout(resolve, 500)); // Network-friendly delay
                } else if (typeof sourceData === 'string' && sourceData.startsWith('http')) {
                  finalUrl = sourceData;
                }

                if (finalUrl) {
                  const fileName = (att.name || '').toLowerCase();
                  const originalType = (att.type || '').toLowerCase();
                  
                  // v443: Standardize to UPPERCASE types for system consistency
                  let type = 'DOCUMENT';
                  if (originalType.includes('video') || fileName.match(/\.(mp4|mov|avi|webm|mkv|3gp|m4v)$/)) {
                    type = 'VIDEO';
                  } else if (originalType.includes('image') || fileName.match(/\.(jpg|jpeg|png|gif|webp|heic|svg)$/)) {
                    type = 'IMAGE';
                  } else if (originalType.includes('audio') || fileName.match(/\.(mp3|wav|ogg|m4a|aac|flac)$/)) {
                    type = 'AUDIO';
                  }

                  uploadedFiles.push({ url: finalUrl, type, name: att.name });
                }
              }

              // v443: Re-standardize payload properties to match AppointmentModal expectations
              finalPayload.files = uploadedFiles;
              finalPayload.attachments = uploadedFiles.map(f => ({ 
                data: f.url, 
                url: f.url, // Provide both for safety
                type: f.type, 
                name: f.name 
              }));
              
              finalPayload.attachmentLinks = uploadedFiles
                .filter(f => f.type === 'VIDEO' || f.type === 'AUDIO')
                .map(f => ({ url: f.url, data: f.url, type: f.type, name: f.name }));

            } catch (err) {
              console.error('[Sync] Failed TASK media sync:', err);
              const currentAttempts = (item.attempts || 0) + 1;
              await db.outbox.update(item.id!, { 
                status: currentAttempts >= 10 ? 'failed' : 'pending',
                attempts: currentAttempts,
                lastAttemptAt: Date.now()
              });
              continue;
            }
          }
          
          if (endpoint) {
             // v260: Clean client-only fields from TASK payloads before sending
             if (item.type === 'TASK') {
               delete finalPayload.isNew
               delete finalPayload.mediaFiles
               delete finalPayload.previews
               // Clean isOffline markers from files array
               if (Array.isArray(finalPayload.files)) {
                 finalPayload.files = finalPayload.files.map((f: any) => {
                   const { isOffline, isNew: _n, ...clean } = f
                   return clean
                 })
               }
               // v370: Also clean attachmentLinks/attachments of offline flags
               if (Array.isArray(finalPayload.attachmentLinks)) {
                 finalPayload.attachmentLinks = finalPayload.attachmentLinks.map((a: any) => {
                   const { isOffline, isNew: _n, ...clean } = a
                   return clean
                 })
               }
               if (Array.isArray(finalPayload.attachments)) {
                 finalPayload.attachments = finalPayload.attachments.map((a: any) => {
                   const { isOffline, isNew: _n, ...clean } = a
                   return clean
                 })
               }
             }

             // v353: Handle PROJECT files — upload each file's binary data to Bunny
             // When created offline, files have fileData: { buffer, type, name } instead of URLs
             if (item.type === 'PROJECT' && Array.isArray(finalPayload.files)) {
               try {
                 const processedFiles: any[] = [];

                 // v400: Classify files into uploadable vs pass-through
                 const toUpload: { index: number; f: any }[] = [];
                 const passThrough: { index: number; result: any }[] = [];

                 for (let fi = 0; fi < finalPayload.files.length; fi++) {
                   const f = finalPayload.files[fi];
                   if ((f.fileData && f.fileData.buffer) || (f.file instanceof File || f.file instanceof Blob)) {
                     toUpload.push({ index: fi, f });
                   } else if (f.url && f.url.startsWith('data:')) {
                     passThrough.push({ index: fi, result: { url: f.url, filename: f.filename, mimeType: f.mimeType, type: f.type, category: f.category, size: f.size } });
                   } else if (f.url && f.url.startsWith('http')) {
                     passThrough.push({ index: fi, result: f });
                   }
                 }

                 // v400: Upload in parallel batches of 3 for speed
                 const UPLOAD_BATCH = 3;
                 const uploadResults: { index: number; result: any }[] = [];

                 for (let bi = 0; bi < toUpload.length; bi += UPLOAD_BATCH) {
                   const batch = toUpload.slice(bi, bi + UPLOAD_BATCH);
                   const batchResults = await Promise.all(batch.map(async ({ index: fi, f }) => {
                     if (f.fileData && f.fileData.buffer) {
                       const blob = new Blob([f.fileData.buffer], { type: f.fileData.type || f.mimeType || 'application/octet-stream' });
                       const uploadResult = await uploadToBunnyClientSide(blob, f.fileData.name || f.filename, 'projects');
                       const result = {
                         url: uploadResult.url,
                         filename: f.filename || f.fileData.name,
                         mimeType: uploadResult.mimeType,
                         type: uploadResult.type,
                         category: f.category,
                         size: f.size
                       };
                       // Memory release
                       f.fileData.buffer = null;
                       f.fileData = null;
                       return { index: fi, result };
                     } else {
                       // File or Blob
                       const uploadResult = await uploadToBunnyClientSide(f.file, f.filename || f.file.name, 'projects');
                       const result = {
                         url: uploadResult.url,
                         filename: f.filename || f.file.name,
                         mimeType: uploadResult.mimeType || f.file.type,
                         type: uploadResult.type,
                         category: f.category,
                         size: f.file.size
                       };
                       f.file = null;
                       return { index: fi, result };
                     }
                   }));
                   uploadResults.push(...batchResults);
                   // GC breathing room between batches
                   await new Promise(resolve => setTimeout(resolve, 100));
                 }

                 // Reassemble in original order
                 const allResults = [...uploadResults, ...passThrough].sort((a, b) => a.index - b.index);
                 for (const { result } of allResults) {
                   processedFiles.push(result);
                 }
                 finalPayload.files = processedFiles;
               } catch (err) {
                 console.error('[Sync] Failed to upload PROJECT files:', err);
                 await db.outbox.update(item.id!, { status: 'pending' });
                 continue;
               }
             }

             // v356: Re-check if item was already synced by Service Worker or another tab
             const recheckItem = await db.outbox.get(item.id!);
             if (!recheckItem || recheckItem.status !== 'syncing') {
               console.log(`[Sync] Item ${item.id} already processed or status changed, skipping.`);
               continue;
             }

             // v430: Dynamic timeout — 120s for gallery/media uploads, 30s for text-only items
             // A 50MB video on 4G (5Mbps) takes ~80s. 30s timeout was causing false 'failed' status.
             const isMediaItem = item.type === 'GALLERY_UPLOAD' || item.type === 'MEDIA_UPLOAD';

             // v443: CRITICAL - Strip ALL binary data before JSON.stringify.
             // After Bunny upload, payload only needs CDN URL + metadata.
             if (isMediaItem) {
               delete finalPayload.file;
               delete finalPayload.fileData;
               delete finalPayload.rawFile;
               delete finalPayload.cacheKey;
               if (typeof finalPayload.base64 === 'string' && finalPayload.base64.length > 200) {
                 delete finalPayload.base64;
               }
               if (finalPayload.media) {
                 delete finalPayload.media.fileData;
                 delete finalPayload.media.base64;
                 if (finalPayload.media.url?.startsWith('blob:') || finalPayload.media.url?.startsWith('data:')) {
                   delete finalPayload.media.url;
                 }
               }
               console.log(`[Sync] POST payload cleaned: url=${(finalPayload.url || '').slice(0, 80)}, filename=${finalPayload.filename}`);
             }

             const controller = new AbortController();
             // v446: Increased timeout for API POST to 5 minutes for media items
             const timeoutMs = isMediaItem ? 300000 : 30000;
             const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
             const res = await fetch(endpoint, {
                 method,
                 headers: { 
                   'Content-Type': 'application/json',
                   'x-sync-id': item.syncId || `sync-${item.id}-${item.timestamp}` 
                 },
                 body: JSON.stringify({ 
                   ...finalPayload, 
                   lat: (item.lat !== null && item.lat !== undefined) ? item.lat : finalPayload.lat, 
                   lng: (item.lng !== null && item.lng !== undefined) ? item.lng : finalPayload.lng, 
                   createdAt: item.timestamp ? new Date(item.timestamp).toISOString() : undefined,
                   isOfflineSync: true 
                 }),
                 signal: controller.signal
             })
             clearTimeout(timeoutId);
              if (res.ok) {
                const resData = await res.json().catch(() => ({}));
                // v366: CRITICAL IDEMPOTENCY FIX
                if (resData.isDuplicate && resData.id === 0) {
                  console.log(`[Sync] Item ${item.id} still pending on server (id: 0). Skipping.`);
                  await db.outbox.update(item.id!, { status: 'pending' });
                  continue;
                }

                await db.outbox.delete(item.id!)
                hasSyncedAnything = true
                await logSync('success', `✓ Sincronizado: ${item.type} #${item.id}`, item.type, `Proyecto ${item.projectId}`);

                // v400: If this was a new PROJECT creation, update all other pending items 
                // in outbox that reference the temporary ID (e.g. "pending-123")
                // v447: ID MAPPING FIX — Map both "pending-ID" and just "ID" (timestamp)
                if (item.type === 'PROJECT' && resData.id) {
                  try {
                    const timestampId = item.id;
                    const tempIdStr = `pending-${item.id}`;
                    
                    // Update ALL items that reference this temporary project
                    const relatedItems = await db.outbox.filter(oi => 
                      String(oi.projectId) === String(timestampId) || 
                      String(oi.projectId) === tempIdStr
                    ).toArray();

                    if (relatedItems.length > 0) {
                      console.log(`[Sync] Mapping ${relatedItems.length} items from ${timestampId}/${tempIdStr} to real ID ${resData.id}`);
                      for (const ri of relatedItems) {
                        await db.outbox.update(ri.id!, { projectId: resData.id });
                      }
                    }
                  } catch (mapErr) {
                    console.warn('[Sync] Failed to map temporary IDs:', mapErr);
                  }
                }

                // v410: Immediately cache synced PROJECT in IndexedDB so it appears
                // in the operator's list without waiting for the next bulk-sync (15 min)
                if (item.type === 'PROJECT' && resData.id) {
                  try {
                    const wizardPayload = item.payload || {};
                    const finalTeam = (resData.team && resData.team.length > 0) ? resData.team : (wizardPayload.team || []).map((tid: any) => ({
                      id: 0,
                      userId: Number(tid),
                      user: { id: Number(tid), name: 'Operador', role: 'OPERATOR', phone: '' }
                    }));

                    const finalGallery = (resData.gallery && resData.gallery.length > 0) 
                      ? resData.gallery 
                      : (finalPayload.files || wizardPayload.files || []).map((f: any) => ({
                          id: Math.random(),
                          url: f.url || '',
                          filename: f.filename || 'upload',
                          mimeType: f.mimeType || 'image/jpeg'
                        }));
                    
                    // v411: IMPORTANT — Before putting the new real record, delete the temporary one
                    // to avoid having duplicate projects in cache (one with timestamp, one with real ID)
                    // which causes the 'infinite syncing' loop in the UI.
                    const tempId = item.id; // item.id is the timestamp for offline projects
                    if (tempId && tempId !== resData.id) {
                      await db.projectsCache.delete(Number(tempId)).catch(() => {});
                      await db.chatCache.delete(Number(tempId)).catch(() => {});
                    }

                    await db.projectsCache.put({
                      ...resData,
                      id: resData.id,
                      createdBy: resData.createdBy || Number(session?.user?.id),
                      team: finalTeam,
                      client: resData.client || wizardPayload.client || { name: '' },
                      phases: resData.phases || (wizardPayload.phases || []).map((p: any, i: number) => ({
                        id: 0, title: p.title, status: 'PENDIENTE', displayOrder: i + 1,
                        estimatedDays: p.estimatedDays || 0
                      })),
                      gallery: finalGallery,
                      isSkeleton: false,
                      lastAccessedAt: Date.now(),
                      chatMessages: [],
                      unreadCount: 0
                    });
                    
                    const u = session?.user as any;
                    const cacheKey = `projects_bulk_${u?.id || 'default'}`;
                    const meta = await db.cacheMetadata.get(cacheKey);
                    if (meta) {
                      await db.cacheMetadata.update(cacheKey, { lastSync: 0, count: (meta.count || 0) + 1 });
                    }
                  } catch (cacheErr) {
                    console.warn('[Sync] Failed to cache synced project:', cacheErr);
                  }
                }

                // v412: CRITICAL — After successful team update, clear flag and fetch FRESH data
                if (item.type === 'TEAM_UPDATE' && item.projectId) {
                  try {
                    let numericId = Number(item.projectId);
                    if (isNaN(numericId) && String(item.projectId).startsWith('pending-')) {
                      numericId = Number(String(item.projectId).replace('pending-', ''));
                    }
                    
                    if (!isNaN(numericId)) {
                      // 1. CLEAR FLAG IMMEDIATELY so UI stops spinning
                      await db.projectsCache.update(numericId, { _pendingTeamSync: false });

                      // 2. Try to hydrate with fresh server data (names, IDs, etc.)
                      const freshProjRes = await fetch(`/api/projects/${numericId}`, { cache: 'no-store' });
                      if (freshProjRes.ok) {
                        const freshData = await freshProjRes.json();
                        if (freshData && freshData.id) {
                          await db.projectsCache.update(numericId, { 
                            ...freshData,
                            _pendingTeamSync: false 
                          });
                        }
                      }
                    }
                  } catch (cacheErr) {
                    console.error('[Sync] Team hydration error:', cacheErr);
                    // Flag is already cleared in step 1, so UI is safe
                  }
                }
                // v425: Handle offline project deletion
                if (item.type === 'PROJECT_DELETE' && item.projectId) {
                  try {
                    const res = await fetch(`/api/projects/${item.projectId}`, { method: 'DELETE' });
                    if (res.ok || res.status === 404) {
                      await db.outbox.delete(item.id!);
                      // Ensure local cleanup is complete
                      await db.projectsCache.delete(item.projectId);
                      await db.chatCache.delete(item.projectId);
                    }
                  } catch (e) {
                    console.error('[Sync] Failed to sync project deletion:', e);
                  }
                }

                // v409: Update projectsCache gallery for media uploads so they persist before reload
                if ((item.type === 'GALLERY_UPLOAD' || item.type === 'MEDIA_UPLOAD') && item.projectId) {
                  try {
                    let numericId = Number(item.projectId);
                    if (isNaN(numericId) && String(item.projectId).startsWith('pending-')) {
                      numericId = Number(String(item.projectId).replace('pending-', ''));
                    }
                    if (!isNaN(numericId) && resData && resData.id) {
                      const proj = await db.projectsCache.get(numericId);
                      if (proj) {
                        const newGallery = proj.gallery ? [...proj.gallery] : [];
                        if (!newGallery.some(g => g.id === resData.id)) {
                          newGallery.push(resData);
                          // Maintain newest first sort order
                          newGallery.sort((a, b) => new Date(b.createdAt || Date.now()).getTime() - new Date(a.createdAt || Date.now()).getTime());
                          await db.projectsCache.update(numericId, { gallery: newGallery });
                        }
                      }
                    }
                  } catch (err) {}
                }

                if (item.type === 'MESSAGE' && item.projectId) {
                  try {
                    let numericId = Number(item.projectId);
                    if (isNaN(numericId) && String(item.projectId).startsWith('pending-')) {
                      numericId = Number(String(item.projectId).replace('pending-', ''));
                    }
                    if (!isNaN(numericId) && resData && resData.id) {
                      const proj = await db.projectsCache.get(numericId);
                      if (proj) {
                        const newMessages = proj.chatMessages ? [...proj.chatMessages] : [];
                        if (!newMessages.some(m => m.id === resData.id)) {
                          newMessages.push(resData);
                          newMessages.sort((a, b) => new Date(a.createdAt || Date.now()).getTime() - new Date(b.createdAt || Date.now()).getTime());
                          await db.projectsCache.update(numericId, { chatMessages: newMessages });
                        }
                      }
                    }
                  } catch (err) {}
                }
                if (typeof window !== 'undefined') {
                  const syncLabel = item.type === 'GALLERY_UPLOAD' ? 'Archivo subido a galería' :
                                    item.type === 'MESSAGE' ? 'Mensaje sincronizado' :
                                    item.type === 'MEDIA_UPLOAD' ? 'Multimedia sincronizada' :
                                    item.type === 'PROJECT' ? 'Proyecto creado' :
                                    item.type === 'EXPENSE' ? 'Gasto sincronizado' :
                                    item.type === 'TASK' ? 'Tarea sincronizada' :
                                    item.type === 'DAY_START' ? 'Jornada iniciada' :
                                    item.type === 'DAY_END' ? 'Jornada finalizada' :
                                    item.type === 'TEAM_UPDATE' ? 'Equipo actualizado' :
                                    item.type === 'GALLERY_DELETE' ? 'Archivo eliminado' :
                                    item.type === 'GALLERY_RENAME' ? 'Archivo renombrado' :
                                    item.type === 'PHASE_COMPLETE' ? 'Fase completada' :
                                    item.type === 'PHASE_CREATE' ? 'Fase creada' :
                                    `Item sincronizado (${item.type})`;
                  const eventProjectId = item.type === 'PROJECT' ? (resData?.id || item.projectId) : item.projectId;
                  window.dispatchEvent(new CustomEvent('sync-success', { detail: { 
                    type: item.type, 
                    projectId: eventProjectId, 
                    label: syncLabel,
                    payload: finalPayload,
                    result: resData
                  } }))
                }
              } else {
               const status = res.status
               if (status === 401 || status === 429) {
                 // Unauthorized or rate limited -> keep pending and retry later
                 if (ctx) failedContexts.add(ctx); // v272: block dependents
                 await db.outbox.update(item.id!, { status: 'pending' })
                 await logSync('warn', `⚠ Rate-limited: ${item.type} #${item.id} (HTTP ${status})`, item.type);
               } else if (status >= 400 && status < 500) {
                 // Permanent client error (400, 403, 404) -> Drop it so it doesn't loop forever
                 await db.outbox.delete(item.id!)
                 await logSync('error', `✗ Descartado: ${item.type} #${item.id} (HTTP ${status})`, item.type);
                 
                 // Clear stuck sync flags
                 if (item.type === 'TEAM_UPDATE' && item.projectId) {
                   try {
                     let numericId = Number(item.projectId);
                     if (isNaN(numericId) && String(item.projectId).startsWith('pending-')) {
                       numericId = Number(String(item.projectId).replace('pending-', ''));
                     }
                     if (!isNaN(numericId)) await db.projectsCache.update(numericId, { _pendingTeamSync: false });
                   } catch (err) {}
                 }
               } else {
                 // Server errors (500+) -> mark as failed and increment attempts
                 if (ctx) failedContexts.add(ctx); // v272: block dependents
                 await db.outbox.update(item.id!, { 
                   status: 'failed',
                   attempts: (item.attempts || 0) + 1,
                   lastAttemptAt: Date.now()
                 })
                 await logSync('error', `✗ Error servidor: ${item.type} #${item.id} (HTTP ${status})`, item.type);
               }
             }
          }
          
          // v365: Increased pacing delay to prevent connection saturation
          await new Promise(r => setTimeout(r, 300));
       } catch (e) {
          // v272: Mark context as failed so dependents are skipped
          if (ctx) failedContexts.add(ctx);
          await logSync('error', `✗ Excepción: ${item.type} #${item.id} — ${e instanceof Error ? e.message : 'Unknown'}`, item.type);
          await db.outbox.update(item.id!, { 
            status: 'pending',
            attempts: (item.attempts || 0) + 1,
            lastAttemptAt: Date.now()
          })
       }
    }

    // v338: NO hacer router.refresh() aquí — causa recarga completa de página
    // en admin/proyectos y rompe la experiencia. En su lugar, emitimos un evento
    // ligero para que los componentes se actualicen solos si lo necesitan.
    if (hasSyncedAnything && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('outbox-items-synced', { 
        detail: { timestamp: Date.now() } 
      }));
    }

    // v282/v302: Fix Infinite Sync Loop.
    // We already iterated through all items in the queue. 
    // If there are still items left, they are either in cooling down state or blocked by dependencies.
    // Do NOT schedule an immediate 3s re-run blindly, as this causes the UI to loop infinitely.
    try {
      const remainingEligible = await db.outbox
        .where('status')
        .anyOf(['pending', 'failed'])
        .filter(item => {
           // Only count items that are NOT in a cooldown
           const attempts = item.attempts || 0;
           if (attempts >= 8) {
             const minsSinceLastAttempt = (Date.now() - (item.lastAttemptAt || item.timestamp || 0)) / 60000;
             if (minsSinceLastAttempt < 2) return false;
           }
           // Only count items that we haven't already tried in this exact run and failed
           return item.lastAttemptAt ? (Date.now() - item.lastAttemptAt > 10000) : true;
        })
        .count();

      if (remainingEligible > 0) {
        setTimeout(() => syncOutbox(), 5000);
      }
    } catch (e) { /* ignore */ }

    } finally {
      outboxLock.current = false;
      lastSyncExecution = Date.now();
      
      // v450: GREEDY RE-TRIGGER
      // If we made progress, don't wait for the 15s interval. Start again in 500ms.
      // This ensures the "robot" never stops as long as there is work to do.
      if (hasSyncedAnything && navigator.onLine) {
        console.log('[Sync] 🤖 Robot codicioso: progreso detectado, reiniciando ciclo inmediato...');
        (window as any)._syncGreedy = true;
        setTimeout(() => syncOutbox(), 500);
      } else {
        (window as any)._syncGreedy = false;
      }
      localStorage.removeItem('global_sync_lock')
    }
  }

  const refreshCaches = async () => {
    if (typeof window === 'undefined' || !navigator.onLine) return
    try {
      // 1. Refresh Materials
      const matRes = await fetch('/api/materials')
      if (matRes.ok) {
        const materials = await matRes.json()
        await db.materialsCache.clear()
        await db.materialsCache.bulkPut(materials.map((m: any) => ({
          ...m,
          unitPrice: Number(m.unitPrice)
        })))
      }

      // 2. Refresh Clients
      const cliRes = await fetch('/api/clients')
      if (cliRes.ok) {
        const clients = await cliRes.json()
        await db.clientsCache.clear()
        await db.clientsCache.bulkPut(clients.map((c: any) => ({
          id: c.id,
          name: c.name,
          ruc: c.ruc || '',
          address: c.address || '',
          phone: c.phone || ''
        })))
      }
      // console.log('[Offline] Caches refreshed successfully')
    } catch (e) {
      console.error('[Offline] Error refreshing caches:', e)
    }
  }

  // v261: Helper to delegate sync to Service Worker (works when app is minimized)
  const registerSwSync = async () => {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      // 1. Register one-shot background sync (fires when connectivity resumes)
      if ('sync' in reg) {
        await (reg as any).sync.register('sync-outbox');
        // console.log('[Sync] Registered SW background sync: sync-outbox');
      }
      // 2. Also trigger immediately via postMessage (SW stays alive to process)
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'TRIGGER_SYNC' });
        // v273: Trigger specific sync types
        navigator.serviceWorker.controller.postMessage({ type: 'TRIGGER_SYNC', specificType: 'MESSAGE' });
        navigator.serviceWorker.controller.postMessage({ type: 'TRIGGER_SYNC', specificType: 'EXPENSE' });
        // console.log('[Sync] Sent TRIGGER_SYNC types to SW via postMessage');
      }
    } catch (e) {
      console.warn('[Sync] SW sync registration failed:', e);
    }
  };

  // v261: Register periodic sync once on mount (Android/Chrome 80+)
  useEffect(() => {
    const registerPeriodicSync = async () => {
      if (!('serviceWorker' in navigator)) return;
      try {
        const reg = await navigator.serviceWorker.ready;
        if ('periodicSync' in reg) {
          try {
            await (reg as any).periodicSync.register('global-sync', {
              minInterval: 15 * 60 * 1000 // 15 minutes
            });
            console.log('[Sync] Periodic background sync registered (15 min interval)');
          } catch (e) {
            // Ignore registration errors
          }
        }
      } catch (e) {
        // console.warn('[Sync] Periodic sync not available:', e);
      }
    };
    registerPeriodicSync();
  }, []);

  useEffect(() => {
    const handleStatusChange = () => {
      setIsOnline(navigator.onLine)
      if (navigator.onLine) {
        logSync('info', '🟢 Conexión restaurada — iniciando sincronización...', 'network');
        syncOutbox()
        refreshCaches()
        // Also wake SW to sync anything it has
        registerSwSync()
      } else {
        logSync('warn', '🔴 Sin conexión a internet', 'network');
      }
    }
    
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && typeof navigator !== 'undefined' && navigator.onLine) {
        // console.log('[Sync] App visible and online, checking for fresh data...');
        syncOutbox()
        // v291: startBulkSync is already throttled (30s) and has freshness check (15m).
        // It's safe to call, but we avoid calling it too aggressively.
        if (!syncLock.current && (Date.now() - lastBulkSyncAttempt > 60000)) {
          startBulkSync()
        }
      } else if (document.visibilityState === 'hidden') {
        // v261: CRITICAL — App going to background!
        // Android suspends JS timers when the app is minimized.
        // We must delegate ALL pending sync work to the Service Worker NOW,
        // because our setInterval-based syncOutbox() will stop firing.
        // console.log('[Sync] App going to BACKGROUND — delegating sync to SW');
        
        // Check if there are pending items
        try {
          const pendingCount = await db.outbox.where('status').anyOf(['pending', 'failed']).count();
          if (pendingCount > 0) {
            // console.log(`[Sync] ${pendingCount} pending items — waking SW for background sync`);
            await registerSwSync();
          }
        } catch (e) {
          // Even if the check fails, still try to register
          await registerSwSync();
        }
      }
    }
    
    const handleManualSync = (e: any) => {
      // console.log('[Sync] Manual sync triggered via event. Force:', e.detail?.force);
      startBulkSync([], undefined, e.detail?.force || false);
    };

    const handleOutboxSyncEvent = () => {
      syncOutbox();
    };

    window.addEventListener('online', handleStatusChange)
    window.addEventListener('offline', handleStatusChange)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('trigger-bulk-sync', handleManualSync)
    window.addEventListener('trigger-outbox-sync', handleOutboxSyncEvent)
    
    // Initial sync and cache refresh
    if (navigator.onLine) {
      // Fire outbox sync after hydration finishes to ensure fast UI paint
      setTimeout(() => {
        syncOutbox()
      }, 2000); 

      // v281: Delay heavy global caches (materials, clients) by 20 SECONDS. 
      // Downloading and parsing megabytes of JSON freezes mobile devices and blocks the main thread.
      setTimeout(() => {
        refreshCaches()
      }, 20000);

      // v374: Reduced to 2s for dev mode — 25s was too long for Fast Refresh
      setTimeout(() => {
        if (!syncLock.current) startBulkSync()
      }, 2000)
    }
    
    // Fase 8: MASTER SYNC LOOP
    // Consolidates all background timers into one coordinated cycle to reduce CPU contention on mobile.
    // Base cycle: 15 seconds.
    let tickCount = 0;
    const masterInterval = setInterval(() => {
        if (!navigator.onLine) return;
        
        tickCount++;
        
        // 1. Every 15s: Primary Outbox Sync
        syncOutbox();

        // 2. Every 120s (8 ticks): Heartbeat
        if (tickCount % 8 === 0) {
            logSync('info', '🤖 Robot vivo — latido coordinado', 'heartbeat').catch(() => {});
        }

        // 3. Every 240s (16 ticks): DB Keep-Alive Ping
        if (tickCount % 16 === 0) {
            fetch('/api/health/ping').catch(() => {});
        }

        // 4. Every 30 mins (120 ticks): Full Bulk Sync
        if (tickCount % 120 === 0) {
            startBulkSync();
            tickCount = 0; // Reset counter
        }
    }, 15000);
    
    // Primer latido inmediato
    logSync('success', '🤖 Robot v333 (Consolidated) iniciado', 'heartbeat');

    return () => {
      window.removeEventListener('online', handleStatusChange)
      window.removeEventListener('offline', handleStatusChange)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('trigger-bulk-sync', handleManualSync)
      window.removeEventListener('trigger-outbox-sync', handleOutboxSyncEvent)
      clearInterval(masterInterval)
    }
  }, [])

  // Render JSX
  const showProgress = !!uploadProgress;
  const showBatteryExemption = isNativePlatform && showBatteryWarning;

  if (!showProgress && !showBatteryExemption) return null;

  return (
    <>
      {showProgress && (
        <div className="sync-progress-container fixed bottom-20 right-4 z-[9999] w-72 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <style>{`
            @media (max-width: 768px) {
              .sync-progress-container {
                left: 50% !important;
                right: auto !important;
                transform: translateX(-50%);
                width: calc(100% - 32px) !important;
                max-width: 350px;
              }
            }
          `}</style>
          <div className="bg-black/80 backdrop-blur-xl border border-white/10 p-5 rounded-3xl shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
            <div className="flex items-center justify-between mb-3">
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-0.5">Sincronizando Multimedia</span>
                <span className="text-sm font-semibold text-white truncate max-w-[180px]">
                  {uploadProgress.filename}
                </span>
              </div>
              <div className="bg-blue-500/10 px-2 py-1 rounded-lg border border-blue-500/20">
                <span className="text-xs text-blue-400 font-black font-mono">
                  {uploadProgress.percent}%
                </span>
              </div>
            </div>
            
            <div className="relative h-2 w-full bg-white/5 rounded-full overflow-hidden">
              <div 
                className="absolute top-0 left-0 h-full bg-gradient-to-r from-blue-600 to-indigo-500 transition-all duration-500 ease-out shadow-[0_0_10px_rgba(37,99,235,0.5)]"
                style={{ width: `${uploadProgress.percent}%` }}
              />
            </div>
            
            <div className="flex justify-between items-center mt-3">
              <p className="text-[10px] text-zinc-500 font-medium">
                Parte <span className="text-zinc-300 font-bold">{uploadProgress.chunk}</span> de <span className="text-zinc-300 font-bold">{uploadProgress.totalChunks}</span>
              </p>
              <div className="flex gap-1">
                <div className="w-1 h-1 rounded-full bg-blue-500 animate-pulse" />
                <div className="w-1 h-1 rounded-full bg-blue-500 animate-pulse delay-75" />
                <div className="w-1 h-1 rounded-full bg-blue-500 animate-pulse delay-150" />
              </div>
            </div>
          </div>
        </div>
      )}

      {showBatteryExemption && (
        <div className="battery-defense-toast fixed bottom-4 right-4 z-[9999] w-[350px] animate-in fade-in slide-in-from-bottom-4 duration-500">
          <style>{`
            @media (max-width: 768px) {
              .battery-defense-toast {
                left: 16px !important;
                right: 16px !important;
                width: auto !important;
              }
            }
          `}</style>
          <div className="bg-[#121214]/95 backdrop-blur-2xl border border-amber-500/20 p-5 rounded-[24px] shadow-[0_20px_50px_rgba(0,0,0,0.6)]">
            <div className="flex gap-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
                <svg className="w-5 h-5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] uppercase tracking-widest text-amber-500 font-bold mb-1">Optimización de Batería</p>
                <h4 className="text-sm font-semibold text-white mb-1.5 font-sans">Permitir Ejecución en 2do Plano</h4>
                <p className="text-xs text-zinc-400 leading-relaxed mb-4">
                  Android suspende la app al apagar la pantalla. Activa el modo "Sin restricciones" para asegurar sincronización 100% confiable.
                </p>
                <div className="flex gap-2">
                  <button 
                    onClick={handleRequestExemption}
                    className="flex-1 bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold py-2.5 px-4 rounded-xl transition-all duration-300 shadow-[0_4px_12px_rgba(245,158,11,0.2)] active:scale-[0.98]"
                  >
                    Configurar Ahora
                  </button>
                  <button 
                    onClick={() => setShowBatteryWarning(false)}
                    className="bg-white/5 hover:bg-white/10 border border-white/10 text-zinc-300 text-xs font-semibold py-2.5 px-4 rounded-xl transition-all duration-300 active:scale-[0.98]"
                  >
                    Después
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
