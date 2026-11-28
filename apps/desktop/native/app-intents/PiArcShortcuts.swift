import AppIntents
import AppKit

@main
struct PiArcShortcuts: AppIntentsExtension {}

@MainActor
private func activatePiArc(_ url: URL? = nil) async throws {
    // Target the app that contains this extension, including when several builds are installed.
    let application = Bundle.main.bundleURL.deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
    if let url {
        _ = try await NSWorkspace.shared.open([url], withApplicationAt: application, configuration: .init())
    } else {
        _ = try await NSWorkspace.shared.openApplication(at: application, configuration: .init())
    }
}

struct OpenPiArc: AppIntent {
    static var title: LocalizedStringResource = "Open PiArc"

    func perform() async throws -> some IntentResult {
        try await activatePiArc()
        return .result()
    }
}

struct OpenWorkspace: AppIntent {
    static var title: LocalizedStringResource = "Open Workspace in PiArc"

    @Parameter(title: "Workspace Path")
    var workspace: String

    func perform() async throws -> some IntentResult {
        try await activatePiArc(ShortcutRoute.workspace.url(workspace: workspace))
        return .result()
    }
}

struct NewSession: AppIntent {
    static var title: LocalizedStringResource = "New Session in PiArc"

    @Parameter(title: "Workspace Path")
    var workspace: String

    @Parameter(title: "Draft Text")
    var text: String?

    func perform() async throws -> some IntentResult {
        try await activatePiArc(ShortcutRoute.draft(text).url(workspace: workspace))
        return .result()
    }
}
