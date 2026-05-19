import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aquatech.crm',
  appName: 'Aquatech CRM',

  // Remote content: la app carga la web desde tu VPS
  // Cuando cambies de dominio, actualiza esta URL
  server: {
    url: 'https://178.238.238.158.sslip.io/admin',
    cleartext: false, // Solo HTTPS
  },

  android: {
    // Permitir debugging del WebView (desactivar en producción)
    webContentsDebuggingEnabled: true,
    // No permitir contenido mixto (HTTP en HTTPS)
    allowMixedContent: false,
    // Usar scheme https para Service Worker
    // Esto es necesario para que el SW funcione correctamente en el WebView
  },

  plugins: {
    // Los plugins nativos se configurarán aquí conforme se añadan
  },
};

export default config;
