'use client'

import { useState, useEffect } from 'react'
import { isNative } from '@/lib/native-bridge'

interface AppVersionInfo {
  version: string
  build: number
  url: string
  changelog: string
}

export default function AutoUpdater() {
  const [updateInfo, setUpdateInfo] = useState<AppVersionInfo | null>(null)
  const [currentVersion, setCurrentVersion] = useState<{ version: string; build: number } | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)

  useEffect(() => {
    if (!isNative()) return

    const checkUpdates = async () => {
      try {
        // 1. Obtener la versión local del paquete APK
        const { SyncBridge } = await import('@/lib/native-bridge')
        const local = await SyncBridge.getAppVersion()
        setCurrentVersion(local)

        // 2. Obtener la última versión en BunnyCDN
        // Agregamos un timestamp para evitar caché agresivo de Cloudflare/Bunny
        const response = await fetch(`https://cesarweb.b-cdn.net/apk-version.json?t=${Date.now()}`, {
          cache: 'no-store'
        })
        
        if (!response.ok) return
        const serverInfo: AppVersionInfo = await response.json()

        // 3. Comparar compilación (Build) o nombre de versión
        if (serverInfo.build > local.build) {
          setUpdateInfo(serverInfo)
          // Demora de 3 segundos para que se cargue la UI principal primero antes de mostrar el aviso
          setTimeout(() => {
            setShowModal(true)
          }, 3000)
        }
      } catch (err) {
        console.warn('[AutoUpdater] Error al verificar actualizaciones', err)
      }
    }

    checkUpdates()
  }, [])

  const handleUpdate = () => {
    if (!updateInfo) return
    setIsDownloading(true)

    // Redirigir directamente al link de descarga del APK en BunnyCDN
    // Esto inicia la descarga nativa en el celular
    window.location.href = updateInfo.url

    // Desactivar el estado de cargando después de iniciar la descarga
    setTimeout(() => {
      setIsDownloading(false)
      setShowModal(false)
    }, 4000)
  }

  if (!showModal || !updateInfo || !currentVersion) return null

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.75)',
      backdropFilter: 'blur(10px)',
      zIndex: 99999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      animation: 'fadeIn 0.3s ease-out'
    }}>
      <div style={{
        background: 'rgba(15, 23, 42, 0.95)',
        border: '1px solid rgba(56, 189, 248, 0.25)',
        borderRadius: '24px',
        padding: '30px',
        maxWidth: '440px',
        width: '100%',
        boxShadow: '0 25px 50px -12px rgba(56, 189, 248, 0.15), 0 0 40px rgba(56, 189, 248, 0.05)',
        color: '#f8fafc',
        textAlign: 'center',
        position: 'relative',
        animation: 'slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)'
      }}>
        {/* Glow Decorator */}
        <div style={{
          position: 'absolute',
          top: '-10%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '80%',
          height: '20%',
          background: 'linear-gradient(90deg, #38bdf8, #0284c7)',
          filter: 'blur(35px)',
          opacity: 0.15,
          pointerEvents: 'none'
        }} />

        {/* Icon */}
        <div style={{
          width: '70px',
          height: '70px',
          borderRadius: '50%',
          backgroundColor: 'rgba(56, 189, 248, 0.1)',
          border: '1px solid rgba(56, 189, 248, 0.3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 20px auto',
          boxShadow: '0 0 20px rgba(56, 189, 248, 0.1)'
        }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </div>

        {/* Title */}
        <h3 style={{
          fontSize: '1.4rem',
          fontWeight: 'bold',
          marginBottom: '10px',
          background: 'linear-gradient(135deg, #f8fafc 0%, #cbd5e1 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent'
        }}>
          ¡Actualización Disponible! ⚡
        </h3>

        <p style={{
          fontSize: '0.9rem',
          color: '#94a3b8',
          marginBottom: '20px'
        }}>
          Una nueva versión nativa de la app está lista. Tu versión actual es la <strong style={{ color: '#38bdf8' }}>v{currentVersion.version} (Build {currentVersion.build})</strong>.
        </p>

        {/* Changelog Card */}
        <div style={{
          background: 'rgba(30, 41, 59, 0.5)',
          border: '1px solid rgba(255, 255, 255, 0.05)',
          borderRadius: '16px',
          padding: '15px',
          textAlign: 'left',
          marginBottom: '25px',
          fontSize: '0.85rem',
          color: '#cbd5e1'
        }}>
          <strong style={{ color: '#f8fafc', display: 'block', marginBottom: '6px' }}>
            Novedades en v{updateInfo.version}:
          </strong>
          {updateInfo.changelog}
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button
            onClick={handleUpdate}
            disabled={isDownloading}
            style={{
              width: '100%',
              padding: '14px',
              borderRadius: '12px',
              backgroundColor: '#38bdf8',
              color: '#0f172a',
              border: 'none',
              fontWeight: '600',
              fontSize: '0.95rem',
              cursor: 'pointer',
              transition: 'all 0.2s',
              boxShadow: '0 4px 14px rgba(56, 189, 248, 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px'
            }}
          >
            {isDownloading ? (
              <>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 1s linear infinite' }}>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <span>Descargando...</span>
              </>
            ) : (
              <>
                <span>Actualizar Ahora</span>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </>
            )}
          </button>

          <button
            onClick={() => setShowModal(false)}
            disabled={isDownloading}
            style={{
              width: '100%',
              padding: '12px',
              borderRadius: '12px',
              backgroundColor: 'transparent',
              color: '#64748b',
              border: '1px solid rgba(255, 255, 255, 0.05)',
              fontWeight: '500',
              fontSize: '0.85rem',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            Recordar más tarde
          </button>
        </div>
      </div>

      <style jsx global>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideUp {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @keyframes spin {
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
