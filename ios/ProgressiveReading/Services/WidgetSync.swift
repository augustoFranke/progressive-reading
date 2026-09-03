import WidgetKit

public enum WidgetSync {
    public static func reload() {
        WidgetCenter.shared.reloadAllTimelines()
    }
}
