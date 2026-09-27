// Build-time icon generator (not shipped). Renders SF Symbols on rounded, gradient tiles.
// Usage: swift tools/make_icons.swift tools/icons.json src
// icons.json: { "icon": ["wrench.and.screwdriver", "#4F46E5"], "json": ["curlybraces", "#F59E0B"], ... }
// The "icon" entry becomes src/icon.png (1024 px); the others become src/icons/<name>.png (256 px).
import AppKit

func color(_ hex: String) -> NSColor {
    var v: UInt64 = 0
    Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&v)
    return NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
}

func render(symbol: String, hex: String, size: CGFloat, to path: String) throws {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let inset = size * 0.06
    let rect = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
    let tile = NSBezierPath(roundedRect: rect, xRadius: size * 0.2, yRadius: size * 0.2)
    let base = color(hex)
    NSGradient(starting: base.blended(withFraction: 0.25, of: .white)!, ending: base.blended(withFraction: 0.2, of: .black)!)!
        .draw(in: tile, angle: -90)
    // Monochrome, then tinted white: a palette with one colour painted every layer white, so the
    // glyph inside filled symbols (checkmark.circle.fill, number.square.fill…) disappeared
    let config = NSImage.SymbolConfiguration(pointSize: size * 0.46, weight: .semibold)
    guard let symbolImage = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(config) else {
        throw NSError(domain: "icons", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown SF Symbol \(symbol)"])
    }
    let img = NSImage(size: symbolImage.size, flipped: false) { r in
        symbolImage.draw(in: r)
        NSColor.white.set()
        r.fill(using: .sourceAtop)
        return true
    }
    let s = img.size
    let scale = min(rect.width * 0.62 / s.width, rect.height * 0.62 / s.height)
    let w = s.width * scale, h = s.height * scale
    img.draw(in: NSRect(x: (size - w) / 2, y: (size - h) / 2, width: w, height: h))
    NSGraphicsContext.restoreGraphicsState()
    try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

let args = CommandLine.arguments
let spec = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[1]))) as! [String: [String]]
let src = args[2]
try FileManager.default.createDirectory(atPath: "\(src)/icons", withIntermediateDirectories: true)
for (name, v) in spec.sorted(by: { $0.key < $1.key }) {
    if name == "icon" {
        try render(symbol: v[0], hex: v[1], size: 1024, to: "\(src)/icon.png")
    } else {
        try render(symbol: v[0], hex: v[1], size: 256, to: "\(src)/icons/\(name).png")
    }
}
print("Rendered \(spec.count) icons")
