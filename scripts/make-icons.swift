// Renders the app icon (.icns) and menu-bar icons from SF Symbols.
// Usage: swift scripts/make-icons.swift <resources-dir>
import AppKit

let outDir = URL(fileURLWithPath: CommandLine.arguments[1])

func symbol(_ name: String, _ size: CGFloat, _ weight: NSFont.Weight, color: NSColor? = nil) -> NSImage {
    var cfg = NSImage.SymbolConfiguration(pointSize: size, weight: weight)
    if let color { cfg = cfg.applying(NSImage.SymbolConfiguration(paletteColors: [color])) }
    return NSImage(systemSymbolName: name, accessibilityDescription: nil)!.withSymbolConfiguration(cfg)!
}

func render(_ px: Int, _ draw: (CGRect) -> Void) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: px, height: px)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    draw(CGRect(x: 0, y: 0, width: px, height: px))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

func drawCentered(_ img: NSImage, in rect: CGRect, scale: CGFloat) {
    let s = img.size
    let k = min(rect.width / s.width, rect.height / s.height) * scale
    let w = s.width * k, h = s.height * k
    img.draw(in: CGRect(x: rect.midX - w / 2, y: rect.midY - h / 2, width: w, height: h))
}

// Menu bar: template waveform (idle) and a coral recording dot + waveform.
for (scale, suffix) in [(1, ""), (2, "@2x")] {
    let px = 18 * scale
    let idle = render(px) { r in drawCentered(symbol("waveform", 64, .semibold), in: r, scale: 0.9) }
    try! idle.write(to: outDir.appendingPathComponent("trayTemplate\(suffix).png"))
    let rec = render(px) { r in
        drawCentered(symbol("record.circle.fill", 64, .semibold, color: NSColor(red: 0.94, green: 0.34, blue: 0.29, alpha: 1)), in: r, scale: 0.92)
    }
    try! rec.write(to: outDir.appendingPathComponent("trayRecording\(suffix).png"))
}

// App icon.
func appIcon(_ px: Int) -> Data {
    render(px) { r in
        let k = r.width / 1024
        let body = CGRect(x: 100 * k, y: 100 * k, width: 824 * k, height: 824 * k)
        let path = NSBezierPath(roundedRect: body, xRadius: 186 * k, yRadius: 186 * k)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
        shadow.shadowBlurRadius = 24 * k
        shadow.shadowOffset = NSSize(width: 0, height: -10 * k)
        shadow.set()
        NSColor.black.setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
        let g = NSGradient(colors: [
            NSColor(red: 0.20, green: 0.19, blue: 0.33, alpha: 1),
            NSColor(red: 0.09, green: 0.09, blue: 0.13, alpha: 1),
        ])!
        g.draw(in: path, angle: -60)
        let sheen = NSGradient(colors: [NSColor.white.withAlphaComponent(0.10), NSColor.white.withAlphaComponent(0)])!
        sheen.draw(in: NSBezierPath(roundedRect: body.insetBy(dx: 0, dy: 0), xRadius: 186 * k, yRadius: 186 * k), angle: -90)
        drawCentered(symbol("waveform", 400, .medium, color: NSColor(white: 0.97, alpha: 1)), in: body.insetBy(dx: 170 * k, dy: 170 * k), scale: 1)
        let dot = CGRect(x: 690 * k, y: 690 * k, width: 108 * k, height: 108 * k)
        NSColor(red: 0.94, green: 0.34, blue: 0.29, alpha: 1).setFill()
        NSBezierPath(ovalIn: dot).fill()
    }
}

let iconset = outDir.appendingPathComponent("icon.iconset")
try? FileManager.default.removeItem(at: iconset)
try! FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    try! appIcon(base).write(to: iconset.appendingPathComponent("icon_\(base)x\(base).png"))
    try! appIcon(base * 2).write(to: iconset.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
try! appIcon(1024).write(to: outDir.appendingPathComponent("icon.png"))
print("icons written to \(outDir.path)")
