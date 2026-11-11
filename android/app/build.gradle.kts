import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// Optional local files, never committed (see android/README.md):
//   firebase.properties  - the Firebase app this build registers with for push
//   keystore.properties  - the release signing key
fun localProperties(name: String): Properties = Properties().apply {
    val file = rootProject.file(name)
    if (file.isFile) file.inputStream().use { load(it) }
}
val firebase = localProperties("firebase.properties")
val keystore = localProperties("keystore.properties")
fun quoted(value: String?): String = "\"" + (value ?: "").trim().replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "dev.crazyagent.remote"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.crazyagent.remote"
        minSdk = 26
        targetSdk = 36
        versionCode = 4
        versionName = "0.5.0"

        // Blank when firebase.properties is absent: the app then builds and runs with push off.
        buildConfigField("String", "FIREBASE_PROJECT_ID", quoted(firebase.getProperty("projectId")))
        buildConfigField("String", "FIREBASE_APPLICATION_ID", quoted(firebase.getProperty("applicationId")))
        buildConfigField("String", "FIREBASE_API_KEY", quoted(firebase.getProperty("apiKey")))
        buildConfigField("String", "FIREBASE_SENDER_ID", quoted(firebase.getProperty("senderId")))
    }

    signingConfigs {
        if (keystore.getProperty("storeFile") != null) {
            create("release") {
                storeFile = rootProject.file(keystore.getProperty("storeFile"))
                storePassword = keystore.getProperty("storePassword")
                keyAlias = keystore.getProperty("keyAlias")
                keyPassword = keystore.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // Unsigned (and not installable) unless keystore.properties is present.
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = false
    }

    lint {
        warningsAsErrors = false
        abortOnError = true
        checkDependencies = false
        // Dependency/SDK freshness checks depend on the day the build runs.
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion", "OldTargetApi")
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.firebase.messaging)
    debugImplementation(libs.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
