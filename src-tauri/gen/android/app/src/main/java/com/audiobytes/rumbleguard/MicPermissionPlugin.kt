// src-tauri/gen/android/app/src/main/java/<your.package>/MicPermissionPlugin.kt

package your.package.name  // match your actual package

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@TauriPlugin
class MicPermissionPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    @Command
    fun checkMicPermission(invoke: Invoke) {
        val granted = ContextCompat.checkSelfPermission(
            activity,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED

        val result = JSObject()
        result.put("granted", granted)
        invoke.resolve(result)
    }

    @Command
    fun requestMicPermission(invoke: Invoke) {
        ActivityCompat.requestPermissions(
            activity,
            arrayOf(Manifest.permission.RECORD_AUDIO),
            1001
        )
        // Note: result comes back via onRequestPermissionsResult
        // For simplicity, resolve immediately and re-check on the frontend
        invoke.resolve()
    }
}