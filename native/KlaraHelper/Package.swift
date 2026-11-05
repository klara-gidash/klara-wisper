// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "KlaraHelper",
    platforms: [.macOS("14.4")],
    targets: [
        .executableTarget(
            name: "KlaraHelper",
            path: "Sources/KlaraHelper",
            swiftSettings: [.unsafeFlags(["-Osize"])],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "Resources/Info.plist"]),
                .linkedFramework("CoreAudio"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("EventKit"),
            ]
        ),
    ]
)
