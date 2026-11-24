#import "AnkielSourceTextRun.h"
#import <React/RCTFabricComponentsPlugins.h>
#import "AnkielSourceTextRunComponentDescriptor.h"
#import <react/renderer/components/AnkielSourceTextSpec/Props.h>
#import <react/renderer/components/AnkielSourceTextSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

@interface AnkielSourceTextRun () <RCTAnkielSourceTextRunViewProtocol>

@end

@implementation AnkielSourceTextRun {
  NSString *_text;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<
      AnkielSourceTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps =
        std::make_shared<const AnkielSourceTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props
           oldProps:(Props::Shared const &)oldProps {
  const auto &oldViewProps =
      *std::static_pointer_cast<AnkielSourceTextRunProps const>(_props);
  const auto &newViewProps =
      *std::static_pointer_cast<AnkielSourceTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> AnkielSourceTextRunCls(void) {
  return AnkielSourceTextRun.class;
}

@end
