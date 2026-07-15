import AppKit
import CoreImage
import Foundation
import Vision

guard CommandLine.arguments.count == 2 else { exit(2) }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: url),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(3) }

// Mail2000 驗證碼右側有一個刷新圖示；它不是答案，先裁掉最右 16%，避免 OCR 把圖示當成字元。
let textWidth = max(1, Int(Double(cgImage.width) * 0.84))
guard let textImage = cgImage.cropping(to: CGRect(x: 0, y: 0, width: textWidth, height: cgImage.height)) else { exit(4) }

// Mail2000 的字很細，原尺寸直接辨識會把 Q 當 O、2 當 L。先用高品質插值放大 4 倍，
// 對歷史上真實成功的 LSQP / Z7XC / J29S 三張驗證碼才能全部正確回讀。
let source = CIImage(cgImage: textImage)
guard let scaler = CIFilter(name: "CILanczosScaleTransform") else { exit(5) }
scaler.setValue(source, forKey: kCIInputImageKey)
scaler.setValue(4.0, forKey: kCIInputScaleKey)
scaler.setValue(1.0, forKey: kCIInputAspectRatioKey)
guard let scaled = scaler.outputImage,
      let recognitionImage = CIContext().createCGImage(scaled, from: scaled.extent) else { exit(6) }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.minimumTextHeight = 0.1
request.recognitionLanguages = ["en-US"]

try VNImageRequestHandler(cgImage: recognitionImage).perform([request])
for observation in request.results ?? [] {
  for candidate in observation.topCandidates(3) {
    let answer = candidate.string.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
    if (4...6).contains(answer.count) {
      print(answer)
      exit(0)
    }
  }
}
exit(5)
