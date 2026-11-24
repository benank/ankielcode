#import <React/RCTUIManager.h>
#import <React/RCTViewManager.h>

@interface AnkielSourceTextManager : RCTViewManager
@end

@implementation AnkielSourceTextManager

RCT_EXPORT_MODULE(AnkielSourceText)

- (UIView *)view {
  return [[UIView alloc] init];
}

@end

@interface AnkielSourceTextRunManager : RCTViewManager
@end

@implementation AnkielSourceTextRunManager

RCT_EXPORT_MODULE(AnkielSourceTextRun)

- (UIView *)view {
  return nil;
}

@end
