#pragma once

#include "HybridAnkielHighlightsSpec.hpp"

namespace margelo::nitro::ankielhighlights {

class HybridAnkielHighlights : public HybridAnkielHighlightsSpec {
public:
  HybridAnkielHighlights() : HybridObject(TAG) {}

  std::optional<std::shared_ptr<ArrayBuffer>> tokenize(SourceText source,
                                                       double language) override;
};

} // namespace margelo::nitro::ankielhighlights
