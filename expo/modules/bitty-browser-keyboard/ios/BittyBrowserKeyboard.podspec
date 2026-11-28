Pod::Spec.new do |s|
  s.name = 'BittyBrowserKeyboard'
  s.version = '1.0.0'
  s.summary = 'Private native keyboard for a remotely controlled browser page'
  s.description = 'Forwards committed keyboard input without exposing an editable chat field.'
  s.author = ''
  s.homepage = 'https://github.com/belcrod5/bitty'
  s.license = 'MIT'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UIKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
