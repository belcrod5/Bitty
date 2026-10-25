#import <AppKit/AppKit.h>
#import <React/RCTView.h>
#import <React/RCTViewManager.h>

@interface BittyDateTimePicker : RCTView
@property (nonatomic, strong) NSDatePicker *picker;
@property (nonatomic, copy) RCTDirectEventBlock onChange;
@end

@implementation BittyDateTimePicker

- (instancetype)initWithFrame:(NSRect)frame
{
  if ((self = [super initWithFrame:frame])) {
    _picker = [[NSDatePicker alloc] initWithFrame:self.bounds];
    _picker.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    _picker.datePickerStyle = NSDatePickerStyleTextFieldAndStepper;
    _picker.datePickerElements = NSDatePickerElementFlagYearMonthDay;
    _picker.continuous = YES;
    _picker.target = self;
    _picker.action = @selector(dateChanged:);
    [self addSubview:_picker];
  }
  return self;
}

- (void)dateChanged:(NSDatePicker *)sender
{
  if (self.onChange) {
    self.onChange(@{ @"timestamp": @(sender.dateValue.timeIntervalSince1970 * 1000) });
  }
}

@end

@interface BittyDateTimePickerManager : RCTViewManager
@end

@implementation BittyDateTimePickerManager

RCT_EXPORT_MODULE(BittyDateTimePicker)
RCT_EXPORT_VIEW_PROPERTY(onChange, RCTDirectEventBlock)

+ (BOOL)requiresMainQueueSetup { return YES; }

- (NSView *)view
{
  return [BittyDateTimePicker new];
}

RCT_CUSTOM_VIEW_PROPERTY(timestamp, double, BittyDateTimePicker)
{
  view.picker.dateValue = [NSDate dateWithTimeIntervalSince1970:[RCTConvert double:json] / 1000];
}

RCT_CUSTOM_VIEW_PROPERTY(accessibilityLabel, NSString, BittyDateTimePicker)
{
  view.picker.accessibilityLabel = [RCTConvert NSString:json];
}

RCT_CUSTOM_VIEW_PROPERTY(mode, NSString, BittyDateTimePicker)
{
  view.picker.datePickerElements = [[RCTConvert NSString:json] isEqualToString:@"time"]
    ? NSDatePickerElementFlagHourMinute : NSDatePickerElementFlagYearMonthDay;
}

@end
