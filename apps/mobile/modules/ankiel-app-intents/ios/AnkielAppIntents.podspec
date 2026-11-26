Pod::Spec.new do |s|
  s.name = 'AnkielAppIntents'
  s.version = '1.0.0'
  s.summary = 'Spotlight entries and App Shortcut handoff for recent threads.'
  s.description = 'Indexes recent threads on device with CoreSpotlight and hands paths from App Shortcuts and Spotlight taps to JavaScript.'
  s.author = 'Ankiel'
  s.homepage = 'https://ankiel.com'
  s.platform = :ios, '18.0'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreSpotlight'
  s.source_files = '*.swift'
end
