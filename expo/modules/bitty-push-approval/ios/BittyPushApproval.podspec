Pod::Spec.new do |s|
  s.name           = 'BittyPushApproval'
  s.version        = '1.0.0'
  s.summary        = 'Native background responder for approval push notification actions'
  s.description    = 'Handles APPROVAL_REQUEST notification action presses entirely natively so the runner receives the approve/deny decision without the app having to come to the foreground.'
  s.author         = ''
  s.homepage       = 'https://github.com/belcrod5/bitty'
  s.license        = 'MIT'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  s.dependency 'EXNotifications'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
