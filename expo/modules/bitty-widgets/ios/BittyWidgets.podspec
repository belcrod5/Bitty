Pod::Spec.new do |s|
  s.name = 'BittyWidgets'
  s.version = '1.0.0'
  s.summary = 'Shared presentation snapshots for Bitty widgets'
  s.description = 'Publishes sanitized app state to the WidgetKit extension.'
  s.author = ''
  s.homepage = 'https://github.com/belcrod5/bitty'
  s.license = 'MIT'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WidgetKit', 'UIKit'
  s.source_files = '**/*.swift'
end
