Pod::Spec.new do |s|
  s.name           = 'BittySttTransport'
  s.version        = '1.0.0'
  s.summary        = 'Direct native PCM transport for Bitty streaming speech recognition'
  s.description    = 'Captures and streams iPhone microphone audio to the Private Runner.'
  s.author         = ''
  s.homepage       = 'https://github.com/belcrod5/bitty'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
