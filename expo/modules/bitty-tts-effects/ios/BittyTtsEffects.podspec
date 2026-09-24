Pod::Spec.new do |s|
  s.name           = 'BittyTtsEffects'
  s.version        = '1.0.0'
  s.summary        = 'Apple audio effects for Bitty TTS playback'
  s.description    = 'Prepares themed TTS audio with Apple audio units.'
  s.author         = ''
  s.homepage       = 'https://github.com/belcrod5/bitty'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'React-Core'
  s.frameworks = 'AVFoundation'
  s.source_files = '**/*.mm'
end
