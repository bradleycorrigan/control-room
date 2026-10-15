#!/usr/bin/swift

import Foundation
import AppKit

// Generate a macOS icon from the fight cloud emoji 🫯
// This script:
// 1. Draws the emoji into a 1024pt NSImage at size * 0.72, centred
// 2. Creates an icon.iconset directory
// 3. Uses sips to resize to all required sizes
// 4. Uses iconutil to create the .icns file

let emoji = "🫯"
let size: CGFloat = 1024
let emojiSize = size * 0.72

// Create NSImage with transparent background
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

// Fill with transparent background (do nothing - it's already transparent)
NSColor.clear.setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: size, height: size)).fill()

// Draw emoji centered
let emojiStr = emoji as NSString
let font = NSFont.systemFont(ofSize: emojiSize)
let attributes: [NSAttributedString.Key: Any] = [.font: font]
let emojiSize_actual = emojiStr.size(withAttributes: attributes)
let xPos = (size - emojiSize_actual.width) / 2
let yPos = (size - emojiSize_actual.height) / 2
emojiStr.draw(at: NSPoint(x: xPos, y: yPos), withAttributes: attributes)

image.unlockFocus()

// Save as 1024x1024 PNG
let pngPath = "./resources/icon.png"
if let tiffData = image.tiffRepresentation,
   let bitmapImage = NSBitmapImageRep(data: tiffData),
   let pngData = bitmapImage.representation(using: .png, properties: [:]) {
    do {
        try pngData.write(to: URL(fileURLWithPath: pngPath))
        print("✓ Generated \(pngPath)")
    } catch {
        print("✗ Failed to write PNG: \(error)")
        exit(1)
    }
} else {
    print("✗ Failed to convert image to PNG")
    exit(1)
}

// Create iconset directory
let iconsetDir = "./resources/icon.iconset"
try? FileManager.default.removeItem(atPath: iconsetDir)
do {
    try FileManager.default.createDirectory(atPath: iconsetDir, withIntermediateDirectories: true)
} catch {
    print("✗ Failed to create iconset directory: \(error)")
    exit(1)
}

// Sizes needed for macOS icon: 16, 32, 64, 128, 256, 512, 1024 (and @2x variants)
let sizes = [(16, "16x16"), (32, "32x32"), (64, "64x64"), (128, "128x128"), (256, "256x256"), (512, "512x512")]

func runCommand(_ cmd: String, args: [String]) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: cmd)
    process.arguments = args
    do {
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus == 0
    } catch {
        print("✗ Failed to run \(cmd): \(error)")
        return false
    }
}

for (size, sizeStr) in sizes {
    // Regular size
    let output1x = "\(iconsetDir)/icon_\(sizeStr).png"
    if runCommand("/usr/bin/sips", args: ["-z", "\(size)", "\(size)", pngPath, "--out", output1x]) {
        print("✓ Generated \(output1x)")
    } else {
        print("✗ Failed to generate \(output1x)")
        exit(1)
    }

    // @2x size
    let size2x = size * 2
    let output2x = "\(iconsetDir)/icon_\(sizeStr)@2x.png"
    if runCommand("/usr/bin/sips", args: ["-z", "\(size2x)", "\(size2x)", pngPath, "--out", output2x]) {
        print("✓ Generated \(output2x)")
    } else {
        print("✗ Failed to generate \(output2x)")
        exit(1)
    }
}

// Generate 512x512@2x (1024x1024) from the original
let output512_2x = "\(iconsetDir)/icon_512x512@2x.png"
if runCommand("/usr/bin/sips", args: ["-c", "ps", "\(Int(size))", "\(Int(size))", pngPath, "--out", output512_2x]) {
    print("✓ Generated \(output512_2x)")
}

// Create .icns file
if runCommand("/usr/bin/iconutil", args: ["-c", "icns", iconsetDir, "-o", "./resources/icon.icns"]) {
    print("✓ Generated ./resources/icon.icns")
} else {
    print("✗ Failed to generate icon.icns")
    exit(1)
}

print("\n✓ Icon generation complete")
