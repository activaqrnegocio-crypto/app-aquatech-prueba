package com.aquatech.crm.sync

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.Build
import android.util.Base64
import android.util.Log
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/**
 * ImageCompressorPlugin — Capacitor plugin for multi-threaded, hardware-accelerated image compression.
 * Migrated from slow Canvas JS-based UI-blocking compression to BitmapFactory/Kotlin.
 * Uses WebP format to minimize payload size and preserves EXIF orientation.
 */
@CapacitorPlugin(name = "ImageCompressor")
class ImageCompressorPlugin : Plugin() {

    private val scope = CoroutineScope(Dispatchers.Default)

    @PluginMethod
    fun compress(call: PluginCall) {
        val base64Str = call.getString("base64") ?: return call.reject("Missing base64 data")
        val maxWidth = call.getInt("maxWidth") ?: 1920
        val quality = call.getInt("quality") ?: 80

        scope.launch {
            try {
                // Strip metadata prefix if exists (e.g., "data:image/jpeg;base64,")
                val cleanBase64 = if (base64Str.contains(",")) {
                    base64Str.substring(base64Str.indexOf(",") + 1)
                } else {
                    base64Str
                }

                val imageBytes = Base64.decode(cleanBase64, Base64.DEFAULT)
                
                // 1. Decode bounds to get original dimensions (no heap allocation yet)
                val options = BitmapFactory.Options().apply {
                    inJustDecodeBounds = true
                }
                BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size, options)
                
                val originalWidth = options.outWidth
                val originalHeight = options.outHeight

                // Calculate inSampleSize to scale down image before loading into memory
                var inSampleSize = 1
                if (originalWidth > maxWidth) {
                    val halfWidth = originalWidth / 2
                    while ((halfWidth / inSampleSize) >= maxWidth) {
                        inSampleSize *= 2
                    }
                }

                // 2. Decode full image with inSampleSize
                val decodeOptions = BitmapFactory.Options().apply {
                    inSampleSize = inSampleSize
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                }
                var bitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size, decodeOptions)
                    ?: return@launch call.reject("Failed to decode image bytes")

                // 3. Precise scaling if still larger than maxWidth
                if (bitmap.width > maxWidth) {
                    val ratio = maxWidth.toFloat() / bitmap.width
                    val targetHeight = (bitmap.height * ratio).toInt()
                    val scaledBitmap = Bitmap.createScaledBitmap(bitmap, maxWidth, targetHeight, true)
                    if (scaledBitmap != bitmap) {
                        bitmap.recycle()
                        bitmap = scaledBitmap
                    }
                }

                // 4. Handle auto-rotation using EXIF
                val rotatedBitmap = fixOrientation(bitmap, imageBytes)
                if (rotatedBitmap != bitmap) {
                    bitmap.recycle()
                    bitmap = rotatedBitmap
                }

                // 5. Compress to WebP (highly optimized on Android)
                val outputStream = ByteArrayOutputStream()
                val compressFormat = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    Bitmap.CompressFormat.WEBP_LOSSY
                } else {
                    @Suppress("DEPRECATION")
                    Bitmap.CompressFormat.WEBP
                }
                
                bitmap.compress(compressFormat, quality, outputStream)
                val compressedBytes = outputStream.toByteArray()
                bitmap.recycle()

                val compressedBase64 = Base64.encodeToString(compressedBytes, Base64.NO_WRAP)
                
                val res = JSObject()
                res.put("compressedBase64", "data:image/webp;base64,$compressedBase64")
                call.resolve(res)
            } catch (e: Exception) {
                Log.e("ImageCompressor", "Compression failed", e)
                call.reject("Compression failed: ${e.message}")
            }
        }
    }

    /**
     * Corrects image orientation based on the EXIF metadata.
     */
    private fun fixOrientation(bitmap: Bitmap, originalBytes: ByteArray): Bitmap {
        try {
            val inputStream = ByteArrayInputStream(originalBytes)
            val exif = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                ExifInterface(inputStream)
            } else {
                return bitmap
            }
            
            val orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            val matrix = Matrix()
            
            when (orientation) {
                ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
                ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
                ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
                else -> return bitmap
            }

            return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        } catch (e: Exception) {
            Log.w("ImageCompressor", "Could not fix orientation", e)
            return bitmap
        }
    }
}
