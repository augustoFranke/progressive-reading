import SwiftUI

@main
struct ProgressiveReadingApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                // Single source of truth for control colour: every native control
                // (buttons, links, progress, toggles) inherits this. Monochrome keeps
                // the app consistent with the neutral app icon.
                .tint(.primary)
        }
    }
}
