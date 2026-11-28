import Foundation

enum ShortcutInputError: LocalizedError {
    case workspace
    case draft

    var errorDescription: String? {
        switch self {
        case .workspace:
            return String(localized: "Enter an absolute local folder path of at most 4096 UTF-16 code units.")
        case .draft:
            return String(localized: "The draft must fit within 4096 UTF-16 code units and contain no null characters.")
        }
    }
}

enum ShortcutRoute {
    case workspace
    case draft(String?)

    func url(workspace: String) throws -> URL {
        guard workspace.hasPrefix("/"), !workspace.hasPrefix("//"), !workspace.hasPrefix("/\\"),
              !workspace.contains("\0"), workspace.utf16.count <= 4096 else {
            throw ShortcutInputError.workspace
        }
        var components = URLComponents()
        components.scheme = "piarc"
        var items = [URLQueryItem(name: "path", value: workspace)]
        switch self {
        case .workspace:
            components.host = "open"
        case .draft(let text):
            components.host = "draft"
            if let text {
                guard text.utf16.count <= 4096, !text.contains("\0") else {
                    throw ShortcutInputError.draft
                }
                items.append(URLQueryItem(name: "text", value: text))
            }
        }
        components.queryItems = items
        // WHATWG URLSearchParams decodes '+' as a space. Foundation leaves literal '+' intact.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let url = components.url else { throw ShortcutInputError.workspace }
        return url
    }
}
