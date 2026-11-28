Pod::Spec.new do |s|
  s.name = 'AnkielHandoff'
  s.version = '1.0.0'
  s.summary = 'Apple Handoff activity support for pairing invites.'
  s.description = 'Publishes and invalidates NSUserActivity entries for Apple Handoff pairing invites from iOS.'
  s.author = 'Ankiel'
  s.homepage = 'https://ankiel.com'
  s.platform = :ios, '18.0'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Foundation'
  s.source_files = '*.swift'
end
