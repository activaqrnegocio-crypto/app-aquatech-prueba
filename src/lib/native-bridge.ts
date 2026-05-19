/**
 * Native Bridge — Puente TypeScript ↔ Kotlin (Capacitor)
 * 
 * Este módulo detecta si la app corre dentro de Capacitor (app nativa Android)
 * o en un navegador normal (PWA). Expone métodos que llaman a los plugins
 * nativos de Kotlin cuando está en la app, o caen al comportamiento web normal.
 * 
 * IMPORTANTE: Este archivo NO afecta la PWA. Las funciones solo se activan
 * cuando Capacitor.isNativePlatform() es true.
 */

import type { OutboxItem } from './db';

// ─── Platform Detection ────────────────────────────────────────────────

let _isNative: boolean | null = null;

/**
 * Detecta si estamos corriendo en la app nativa (Capacitor) o en el navegador.
 * El resultado se cachea después de la primera llamada.
 */
export function isNative(): boolean {
  if (_isNative !== null) return _isNative;
  
  try {
    // Capacitor inyecta este objeto cuando corre en WebView nativo
    const win = window as any;
    _isNative = !!(win.Capacitor && win.Capacitor.isNativePlatform && win.Capacitor.isNativePlatform());
  } catch {
    _isNative = false;
  }
  
  return _isNative;
}

/**
 * Obtiene la plataforma actual: 'android', 'ios', o 'web'
 */
export function getPlatform(): 'android' | 'ios' | 'web' {
  try {
    const win = window as any;
    if (win.Capacitor?.getPlatform) {
      return win.Capacitor.getPlatform();
    }
  } catch {
    // ignore
  }
  return 'web';
}

// ─── Sync Bridge ────────────────────────────────────────────────────────

export interface NativeSyncItem {
  type: OutboxItem['type'];
  endpoint: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  payloadJson: string;
  syncId: string;
  projectId?: number;
  priority?: number; // 0=normal, 1=high, 2=critical
  editedAt?: number;
}

export interface NativeSyncStatus {
  pending: number;
  syncing: number;
  completed: number;
  failed: number;
  conflicts: number;
  completedToday: number;
  lastSyncAt: number | null;
  networkType: 'WIFI' | 'CELLULAR' | 'NONE' | 'OTHER';
  networkSpeed: number; // Kbps
  batteryLevel: number;
  isBatteryOptimized: boolean;
  pendingItems: Array<{
    id: string;
    type: string;
    status: string;
    createdAt: number;
    errorMessage?: string;
  }>;
}

/**
 * SyncBridge — Interfaz con el SyncBridgePlugin nativo de Kotlin.
 * Solo funciona cuando isNative() es true.
 */
export const SyncBridge = {
  /**
   * Encola un item para sincronización nativa.
   * El Foreground Service de Kotlin lo procesará en background.
   */
  async enqueue(item: NativeSyncItem): Promise<{ id: string }> {
    if (!isNative()) throw new Error('SyncBridge only available on native platform');
    const { Capacitor } = await import('@capacitor/core');
    const result = await (Capacitor as any).Plugins.SyncBridge.enqueue({
      type: item.type,
      endpoint: item.endpoint,
      method: item.method,
      payloadJson: item.payloadJson,
      syncId: item.syncId || crypto.randomUUID(),
      projectId: item.projectId || 0,
      priority: item.priority || 0,
      editedAt: item.editedAt || Date.now(),
    });
    return { id: result.id };
  },

  /**
   * Encola un archivo binario para subir a BunnyCDN.
   * @param fileBase64 El archivo en base64
   * @param filename Nombre del archivo
   * @param mimeType Tipo MIME
   * @param linkedSyncId ID del SyncItem relacionado (para vincular la URL después del upload)
   */
  async enqueueFile(fileBase64: string, filename: string, mimeType: string, linkedSyncId?: string): Promise<{ filePath: string }> {
    if (!isNative()) throw new Error('SyncBridge only available on native platform');
    const { Capacitor } = await import('@capacitor/core');
    const result = await (Capacitor as any).Plugins.SyncBridge.enqueueFile({
      fileBase64,
      filename,
      mimeType,
      linkedSyncId: linkedSyncId || '',
    });
    return { filePath: result.filePath };
  },

  /**
   * Obtiene el estado actual de la cola de sincronización.
   */
  async getStatus(): Promise<NativeSyncStatus> {
    if (!isNative()) throw new Error('SyncBridge only available on native platform');
    const { Capacitor } = await import('@capacitor/core');
    return await (Capacitor as any).Plugins.SyncBridge.getStatus();
  },

  /**
   * Fuerza la sincronización inmediata (arranca el Foreground Service).
   */
  async forceSync(): Promise<void> {
    if (!isNative()) throw new Error('SyncBridge only available on native platform');
    const { Capacitor } = await import('@capacitor/core');
    await (Capacitor as any).Plugins.SyncBridge.forceSync();
  },

  /**
   * Resuelve un conflicto: el usuario elige su versión o la del servidor.
   */
  async resolveConflict(syncItemId: string, resolution: 'USE_LOCAL' | 'USE_SERVER'): Promise<void> {
    if (!isNative()) throw new Error('SyncBridge only available on native platform');
    const { Capacitor } = await import('@capacitor/core');
    await (Capacitor as any).Plugins.SyncBridge.resolveConflict({ syncItemId, resolution });
  },

  /**
   * Verifica si la app nativa tiene permiso de notificaciones (Android 13+).
   */
  async checkNotificationPermission(): Promise<boolean> {
    if (!isNative()) return false;
    const { Capacitor } = await import('@capacitor/core');
    try {
      const result = await (Capacitor as any).Plugins.SyncBridge.checkNotificationPermission();
      return !!result.granted;
    } catch {
      return false;
    }
  },

  /**
   * Solicita el permiso nativo de notificaciones al sistema Android (Android 13+).
   */
  async requestNotificationPermission(): Promise<boolean> {
    if (!isNative()) return false;
    const { Capacitor } = await import('@capacitor/core');
    try {
      const result = await (Capacitor as any).Plugins.SyncBridge.requestNotificationPermission();
      return !!result.granted;
    } catch {
      return false;
    }
  },

  /**
   * Retorna la versión nativa del paquete APK actual (versionName y versionCode).
   */
  async getAppVersion(): Promise<{ version: string; build: number }> {
    if (!isNative()) return { version: '1.0.0', build: 1 };
    const { Capacitor } = await import('@capacitor/core');
    try {
      const result = await (Capacitor as any).Plugins.SyncBridge.getAppVersion();
      return {
        version: result.version || '1.0.0',
        build: Number(result.build) || 1
      };
    } catch {
      return { version: '1.0.0', build: 1 };
    }
  },

  /**
   * Registra un listener para eventos del servicio de sync nativo.
   */
  onSyncEvent(callback: (event: { type: string; itemId?: string; data?: any }) => void): void {
    if (!isNative()) return;
    
    try {
      const win = window as any;
      if (win.Capacitor?.Plugins?.SyncBridge) {
        win.Capacitor.Plugins.SyncBridge.addListener('syncEvent', callback);
      }
    } catch {
      // Ignore on web
    }
  },
};

// ─── Image Compressor Bridge ────────────────────────────────────────────

export const ImageCompressor = {
  /**
   * Comprime una imagen usando BitmapFactory nativo (4x más rápido que Canvas JS).
   * @param base64 Imagen original en base64
   * @param maxWidth Ancho máximo
   * @param quality Calidad 0-100
   * @returns base64 de la imagen comprimida en WebP
   */
  async compress(base64: string, maxWidth: number = 1920, quality: number = 80): Promise<string> {
    if (!isNative()) throw new Error('ImageCompressor only available on native platform');
    const { Capacitor } = await import('@capacitor/core');
    const result = await (Capacitor as any).Plugins.ImageCompressor.compress({
      base64,
      maxWidth,
      quality,
    });
    return result.compressedBase64;
  },
};

// ─── Migration Bridge ───────────────────────────────────────────────────

export const MigrationBridge = {
  /**
   * Verifica si se necesita migrar datos de IndexedDB a Room DB.
   */
  async checkNeeded(): Promise<boolean> {
    if (!isNative()) return false;
    const { Capacitor } = await import('@capacitor/core');
    const result = await (Capacitor as any).Plugins.Migration.checkAndMigrate();
    return result.needsMigration;
  },

  /**
   * Importa items del outbox de IndexedDB a Room DB nativa.
   */
  async importOutboxItems(items: OutboxItem[]): Promise<number> {
    if (!isNative()) return 0;
    const { Capacitor } = await import('@capacitor/core');
    const result = await (Capacitor as any).Plugins.Migration.importOutboxItems({
      items: items.map(item => ({
        type: item.type,
        projectId: item.projectId,
        payload: JSON.stringify(item.payload),
        syncId: item.syncId || crypto.randomUUID(),
        timestamp: item.timestamp,
        status: item.status,
      })),
    });
    return result.imported;
  },

  /**
   * Marca la migración como completada.
   */
  async markComplete(): Promise<void> {
    if (!isNative()) return;
    const { Capacitor } = await import('@capacitor/core');
    await (Capacitor as any).Plugins.Migration.markComplete();
  },
};

// ─── Network Monitor Bridge ─────────────────────────────────────────────

export const NetworkBridge = {
  /**
   * Obtiene información detallada de la conexión de red.
   * En web, cae a navigator.onLine (menos detallado).
   */
  async getInfo(): Promise<{
    isConnected: boolean;
    type: 'WIFI' | 'CELLULAR' | 'NONE' | 'OTHER';
    speedKbps: number;
  }> {
    if (!isNative()) {
      return {
        isConnected: navigator.onLine,
        type: navigator.onLine ? 'OTHER' : 'NONE',
        speedKbps: 0,
      };
    }
    const { Capacitor } = await import('@capacitor/core');
    return await (Capacitor as any).Plugins.NetworkMonitor.getInfo();
  },
};

// ─── Battery Defense Bridge ─────────────────────────────────────────────

export const BatteryBridge = {
  /**
   * Solicita al usuario que excluya la app de la optimización de batería.
   * Necesario para que el Foreground Service funcione en Xiaomi/Huawei/Samsung.
   */
  async requestBatteryExemption(): Promise<void> {
    if (!isNative()) return;
    const { Capacitor } = await import('@capacitor/core');
    await (Capacitor as any).Plugins.BatteryDefense.requestExemption();
  },

  /**
   * Obtiene instrucciones específicas para el fabricante del teléfono.
   */
  async getManufacturerInstructions(): Promise<string> {
    if (!isNative()) return '';
    const { Capacitor } = await import('@capacitor/core');
    const result = await (Capacitor as any).Plugins.BatteryDefense.getInstructions();
    return result.instructions;
  },

  /**
   * Verifica si la app ya está excluida de la optimización de batería.
   */
  async isExempt(): Promise<boolean> {
    if (!isNative()) return false;
    const { Capacitor } = await import('@capacitor/core');
    const result = await (Capacitor as any).Plugins.BatteryDefense.isExempt();
    return result.isExempt;
  },
};
