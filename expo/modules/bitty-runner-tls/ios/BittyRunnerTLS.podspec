Pod::Spec.new do |s|
  s.name = 'BittyRunnerTLS'
  s.version = '1.0.0'
  s.summary = 'QR-paired local Runner TLS trust and transport'
  s.author = ''
  s.homepage = 'https://github.com/belcrod5/bitty'
  s.license = 'MIT'
  s.platforms = { :ios => '15.1' }
  s.source = { git: '' }
  s.static_framework = true
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
  s.dependency 'React-Core'
  s.dependency 'ReactNativeEnrichedMarkdown'
  s.frameworks = 'Security', 'AVFoundation'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift}'
end
