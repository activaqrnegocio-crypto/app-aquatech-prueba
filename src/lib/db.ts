import Dexie, { type Table } from 'dexie';

export interface OutboxItem {
  id?: number;
  type: 'MESSAGE' | 'EXPENSE' | 'EXPENSE_DELETE' | 'DAY_START' | 'DAY_END' | 'PHASE_COMPLETE' | 'PHASE_UPDATE' | 'PHASE_CREATE' | 'TEAM_UPDATE' | 'MEDIA_UPLOAD' | 'GALLERY_UPLOAD' | 'GALLERY_DELETE' | 'GALLERY_RENAME' | 'QUOTE' | 'MATERIAL' | 'PROJECT' | 'PROJECT_UPDATE' | 'PROJECT_DELETE' | 'TASK' | 'TASK_STATUS_TOGGLE' | 'LOCATION';
  projectId: number;
  payload: any;
  timestamp: number;
  lat?: number;
  lng?: number;
  status: 'pending' | 'syncing' | 'failed' | 'synced';
  attempts?: number;
  syncId?: string;
  lastAttemptAt?: number;
  failReason?: string; // v373: Motivo del fallo permanente
}

export interface AuthCache {
  id: string; // 'last_session' or 'current'
  username: string;
  name: string;
  role: 'ADMIN' | 'OPERATOR' | 'SUBCONTRATISTA' | 'SUPERADMIN' | 'ADMINISTRADORA';
  userId: string;
  permissions?: string | null; // v232: Store permissions for consistent offline UI
  lastLogin: number;
}

export interface MaterialCache {
  id: number;
  code: string;
  name: string;
  description?: string;
  unit?: string;
  unitPrice: number;
  category?: string;
  stock: number;
}

export interface ClientCache {
  id: number;
  name: string;
  ruc?: string;
  address?: string;
  phone?: string;
}

export interface CacheMetadata {
  id: string; // e.g., 'projects_bulk'
  lastSync: number;
  count: number;
  status: 'idle' | 'syncing' | 'error';
}

export interface UserCache {
  id: number | string;
  name: string;
  role: string;
}

export interface SyncLog {
  id?: number;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  details?: string;
  type?: string;
}


export class OfflineDatabase extends Dexie {
  outbox!: Table<OutboxItem>;
  auth!: Table<AuthCache>;
  authShadow!: Table<any>; // For the Service Worker fallback
  materialsCache!: Table<MaterialCache>;
  clientsCache!: Table<ClientCache>;
  quotesCache!: Table<any>;
  projectsCache!: Table<any>;
  appointmentsCache!: Table<any>;
  chatCache!: Table<any>;
  dashboardCache!: Table<any>;
  cacheMetadata!: Table<CacheMetadata>;
  usersCache!: Table<UserCache>;
  syncLogs!: Table<SyncLog>;
  drafts!: Table<{ key: string; value: any }>;


  constructor() {
    super('AquatechOfflineDB');
    this.version(2).stores({
      outbox: '++id, projectId, status, timestamp',
      auth: 'id'
    });
    this.version(3).stores({
      outbox: '++id, projectId, status, timestamp',
      auth: 'id',
      materialsCache: 'id, code, name, category'
    });
    this.version(6).stores({
      outbox: '++id, projectId, status, timestamp, type',
      auth: 'id',
      materialsCache: 'id, code, name, category',
      clientsCache: 'id, name, ruc'
    });
    this.version(7).stores({
      outbox: '++id, projectId, status, timestamp, type',
      auth: 'id',
      authShadow: 'id',
      materialsCache: 'id, code, name, category',
      clientsCache: 'id, name, ruc'
    });
    this.version(8).stores({
      outbox: '++id, projectId, status, timestamp, type',
      auth: 'id',
      authShadow: 'id',
      materialsCache: 'id, code, name, category',
      clientsCache: 'id, name, ruc',
      quotesCache: 'id, clientName, projectId',
      projectsCache: 'id, title',
      appointmentsCache: 'id, projectId',
      chatCache: 'projectId'
    });
    this.version(9).stores({
      outbox: '++id, projectId, status, timestamp, type',
      auth: 'id',
      authShadow: 'id',
      materialsCache: 'id, code, name, category',
      clientsCache: 'id, name, ruc',
      quotesCache: 'id, clientName, projectId',
      projectsCache: 'id, title',
      appointmentsCache: 'id, projectId',
      chatCache: 'projectId',
      dashboardCache: 'id'
    });
    this.version(11).stores({
      outbox: '++id, projectId, status, timestamp, type',
      auth: 'id',
      authShadow: 'id',
      materialsCache: 'id, code, name, category',
      clientsCache: 'id, name, ruc',
      quotesCache: 'id, clientName, projectId',
      projectsCache: 'id, title, lastAccessedAt',
      appointmentsCache: 'id, projectId',
      chatCache: 'projectId',
      dashboardCache: 'id',
      cacheMetadata: 'id'
    });
    this.version(12).stores({
      outbox: '++id, projectId, status, timestamp, type, attempts',
      auth: 'id',
      authShadow: 'id',
      materialsCache: 'id, code, name, category',
      clientsCache: 'id, name, ruc',
      quotesCache: 'id, clientName, projectId',
      projectsCache: 'id, title, lastAccessedAt',
      appointmentsCache: 'id, projectId',
      chatCache: 'projectId',
      dashboardCache: 'id',
      cacheMetadata: 'id'
    });
    this.version(13).stores({
      outbox: '++id, projectId, status, timestamp, type, attempts',
      auth: 'id',
      authShadow: 'id',
      materialsCache: 'id, code, name, category',
      clientsCache: 'id, name, ruc',
      quotesCache: 'id, clientName, projectId',
      projectsCache: 'id, title, lastAccessedAt',
      appointmentsCache: 'id, projectId',
      chatCache: 'projectId',
      dashboardCache: 'id',
      cacheMetadata: 'id',
      usersCache: 'id, name, role'
    });
    this.version(15).stores({
      outbox: '++id, projectId, status, timestamp, type, attempts',
      auth: 'id',
      authShadow: 'id',
      materialsCache: 'id, code, name, category',
      clientsCache: 'id, name, ruc',
      quotesCache: 'id, clientName, projectId',
      projectsCache: 'id, title, lastAccessedAt',
      appointmentsCache: 'id, projectId, userId',
      chatCache: 'projectId',
      dashboardCache: 'id',
      cacheMetadata: 'id',
      usersCache: 'id, name, role',
      syncLogs: '++id, timestamp, level, type'
    });
    // v16: drafts table — stores File objects (IndexedDB structured clone)
    this.version(16).stores({
      outbox: '++id, projectId, status, timestamp, type, attempts',
      auth: 'id',
      authShadow: 'id',
      materialsCache: 'id, code, name, category',
      clientsCache: 'id, name, ruc',
      quotesCache: 'id, clientName, projectId',
      projectsCache: 'id, title, lastAccessedAt',
      appointmentsCache: 'id, projectId, userId',
      chatCache: 'projectId',
      dashboardCache: 'id',
      cacheMetadata: 'id',
      usersCache: 'id, name, role',
      syncLogs: '++id, timestamp, level, type',
      drafts: 'key'  // key-value store for wizard drafts, preserves File objects (structured clone)
    });

  }
}

export const db = new OfflineDatabase();

// Interceptar db.outbox.add para duplicar en el SQLite nativo de Room cuando estamos en la app
const originalAdd = db.outbox.add.bind(db.outbox);
(db.outbox as any).add = async function (item: OutboxItem, key?: any): Promise<any> {
  // 1. Generar un syncId único si no existe
  if (!item.syncId) {
    item.syncId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);
  }
  
  // 2. Guardar localmente en IndexedDB para respuesta instantánea de UI
  const id = await originalAdd(item);
  item.id = id;
  
  // 3. Si corre en Android nativo (Capacitor), replicar en Room DB nativa
  try {
    const { isNative, SyncBridge } = await import('./native-bridge');
    if (isNative()) {
      let endpoint = '';
      let method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST';
      
      // Mapear tipo de outbox a endpoint y método del backend
      if (item.type === 'QUOTE') { endpoint = '/api/quotes'; }
      else if (item.type === 'MATERIAL') { endpoint = '/api/materials'; }
      else if (item.type === 'MESSAGE' || item.type === 'MEDIA_UPLOAD' || item.type === 'LOCATION') { 
        endpoint = `/api/projects/${item.projectId}/messages`; 
      }
      else if (item.type === 'EXPENSE') { 
        if (item.payload?.id) {
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
      else if (item.type === 'DAY_START') { endpoint = `/api/day-records`; }
      else if (item.type === 'DAY_END') { endpoint = `/api/day-records`; method = 'PUT'; }
      else if (item.type === 'PHASE_COMPLETE' || item.type === 'PHASE_UPDATE') { 
        endpoint = `/api/projects/${item.projectId}/phases/${item.payload.phaseId}`; 
        method = 'PATCH';
      }
      else if (item.type === 'PHASE_CREATE') {
        endpoint = `/api/projects/${item.projectId}/phases`;
        method = 'POST';
      }
      else if (item.type === 'PROJECT') { endpoint = '/api/projects'; }
      else if (item.type === 'PROJECT_UPDATE') { endpoint = `/api/projects/${item.projectId}`; method = 'PATCH'; }
      else if (item.type === 'TEAM_UPDATE') { endpoint = `/api/projects/${item.projectId}/team`; method = 'PUT'; }
      else if (item.type === 'TASK') {
        if (!item.payload?.isNew && (item.payload?.id || item.payload?._id)) {
          endpoint = `/api/appointments/${item.payload.id || item.payload._id}`;
          method = 'PATCH';
        } else {
          endpoint = '/api/appointments';
        }
      }
      else if (item.type === 'TASK_STATUS_TOGGLE') { endpoint = `/api/appointments/${item.payload.appointmentId}`; method = 'PATCH'; }
      else if (item.type === 'GALLERY_UPLOAD') { endpoint = `/api/projects/${item.projectId}/gallery`; }
      else if (item.type === 'GALLERY_DELETE') { endpoint = `/api/projects/${item.projectId}/gallery/${item.payload.galleryId}`; method = 'DELETE'; }
      else if (item.type === 'GALLERY_RENAME') { 
        endpoint = `/api/projects/${item.projectId}/gallery/${item.payload.galleryId}`; 
        method = 'PATCH'; 
      }
      
      if (endpoint) {
        let cleanPayload = { ...item.payload };
        
        // Manejo especial de archivos multimedia en nativo (evitar blobs en SQLite)
        if (item.type === 'GALLERY_UPLOAD') {
          let fileBase64 = '';
          const filename = item.payload?.filename || `gallery_${Date.now()}`;
          const mimeType = item.payload?.mimeType || 'image/jpeg';
          
          if (item.payload?.fileData?.base64) {
            fileBase64 = item.payload.fileData.base64;
          } else if (item.payload?.base64) {
            fileBase64 = item.payload.base64;
          } else if (item.payload?.file instanceof File || item.payload?.file instanceof Blob) {
            fileBase64 = await fileToBase64(item.payload.file);
          }
          
          if (fileBase64) {
            const base64Data = fileBase64.includes('base64,') ? fileBase64.split('base64,')[1] : fileBase64;
            const fileRes = await SyncBridge.enqueueFile(base64Data, filename, mimeType, item.syncId);
            
            cleanPayload.url = fileRes.filePath;
            delete cleanPayload.file;
            delete cleanPayload.fileData;
            delete cleanPayload.base64;
          }
        } else if (item.type === 'MEDIA_UPLOAD' || (item.type === 'MESSAGE' && item.payload?.media)) {
          let fileBase64 = '';
          const filename = item.payload?.media?.filename || item.payload?.filename || `media_${Date.now()}`;
          const mimeType = item.payload?.media?.mimeType || item.payload?.mimeType || 'image/jpeg';
          
          if (item.payload?.media?.fileData?.base64) {
            fileBase64 = item.payload.media.fileData.base64;
          } else if (item.payload?.media?.base64) {
            fileBase64 = item.payload.media.base64;
          } else if (item.payload?.file instanceof File || item.payload?.file instanceof Blob) {
            fileBase64 = await fileToBase64(item.payload.file);
          }
          
          if (fileBase64) {
            const base64Data = fileBase64.includes('base64,') ? fileBase64.split('base64,')[1] : fileBase64;
            const fileRes = await SyncBridge.enqueueFile(base64Data, filename, mimeType, item.syncId);
            
            cleanPayload.media = {
              ...cleanPayload.media,
              url: fileRes.filePath,
              fileData: null,
              base64: null
            };
          }
        }
        
        await SyncBridge.enqueue({
          type: item.type,
          endpoint,
          method,
          payloadJson: JSON.stringify(cleanPayload),
          syncId: item.syncId,
          projectId: item.projectId || 0,
          priority: 0,
          editedAt: Date.now()
        });
        
        // Disparar sincronización inmediata nativa
        await SyncBridge.forceSync();
      }
    }
  } catch (err) {
    console.error('[SyncBridge] Error al replicar cola en Room nativo:', err);
  }
  
  return id;
};

// Conversor de File a base64 asíncrono
function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
    reader.readAsDataURL(file);
  });
}

