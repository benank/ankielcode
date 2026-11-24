#pragma once

#include <react/renderer/components/AnkielSourceTextSpec/EventEmitters.h>
#include <react/renderer/components/AnkielSourceTextSpec/Props.h>
#include <react/renderer/components/AnkielSourceTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char AnkielSourceTextRunComponentName[];

using AnkielSourceTextRunShadowNode =
    ConcreteViewShadowNode<AnkielSourceTextRunComponentName, AnkielSourceTextRunProps,
                           AnkielSourceTextRunEventEmitter, AnkielSourceTextRunState>;
} // namespace facebook::react
