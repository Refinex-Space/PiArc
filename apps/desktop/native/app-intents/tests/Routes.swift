import Foundation

@main
struct RouteTests {
    static func main() throws {
        let path = "/tmp/test workspace+A&B"
        let workspace = try ShortcutRoute.workspace.url(workspace: path)
        precondition(workspace.absoluteString == "piarc://open?path=/tmp/test%20workspace%2BA%26B")
        let blank = try ShortcutRoute.draft(nil).url(workspace: "/tmp/project")
        precondition(blank.absoluteString == "piarc://draft?path=/tmp/project")
        let draft = try ShortcutRoute.draft("/review\n&send=true+#").url(workspace: path)
        precondition(draft.absoluteString == "piarc://draft?path=/tmp/test%20workspace%2BA%26B&text=/review%0A%26send%3Dtrue%2B%23")

        let limit = String(repeating: "😀", count: 2048)
        _ = try ShortcutRoute.draft(limit).url(workspace: path)
        do {
            _ = try ShortcutRoute.draft(limit + "a").url(workspace: path)
            fatalError("Accepted an oversized draft")
        } catch ShortcutInputError.draft {}
        for invalid in ["", "relative/path", "//remote", "/\\remote", "/tmp/\0project"] {
            do {
                _ = try ShortcutRoute.workspace.url(workspace: invalid)
                fatalError("Accepted an invalid workspace")
            } catch ShortcutInputError.workspace {}
        }
        print("Workspace and draft URLs preserve their parameters and enforce the input limits.")
    }
}
