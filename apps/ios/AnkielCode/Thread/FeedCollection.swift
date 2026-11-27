import AnkielKit
import SwiftUI
import UIKit

/// One cell of the feed.
enum FeedItem: Equatable {
  case row(TimelineRow, spacing: CGFloat, expanded: Bool, load: ThreadDetailModel.DetailLoad?)
  case pending(PendingRow, spacing: CGFloat)

  var id: String {
    switch self {
    case .row(let row, _, _, _): row.id
    case .pending(let row, _): row.id
    }
  }
}

/// Published to SwiftUI only when it changes (not on every scroll tick).
@MainActor @Observable
final class FeedStatus {
  var following = true
  var unseen = false
  @ObservationIgnored weak var controller: FeedViewController?
}

/// The feed's container: a `UICollectionView` of self-sizing SwiftUI rows. A lazy SwiftUI stack
/// estimates the height of rows it has not built and corrects them a frame later, which moved the
/// reader's rows (and left blank space) when large folds opened; here every layout pass ends by
/// re-applying the reader's anchor (`FeedScroll`) before the frame is drawn.
struct FeedCollection: UIViewControllerRepresentable {
  let items: [FeedItem]
  let revision: Int
  let model: ThreadDetailModel
  let images: ThreadImages
  let openThread: (String) -> Void
  let status: FeedStatus
  /// The bars, the composer and the keyboard: SwiftUI's safe area, which a representable that
  /// ignores it does not see.
  let insets: EdgeInsets
  /// Room after the last row for what floats over the feed's end (the request dock). An inset, not
  /// a spacer row: a row resizing with the dock during the keyboard's animation sent the
  /// collection view's self-sizing pass into a loop.
  let trailingSpace: CGFloat
  let app: AppModel

  func makeUIViewController(context: Context) -> FeedViewController {
    let controller = FeedViewController(model: model, status: status)
    status.controller = controller
    return controller
  }

  func updateUIViewController(_ controller: FeedViewController, context: Context) {
    controller.images = images
    controller.openThread = openThread
    controller.setRowEnvironment(FeedRowEnvironment(context.environment, app: app))
    controller.reduceMotion = context.environment.accessibilityReduceMotion
    // Inset changes ride SwiftUI's animation (the keyboard's, the composer's).
    context.animate { controller.setInsets(top: insets.top, bottom: insets.bottom + Spacing.xl + trailingSpace) }
    controller.update(items, revision: revision)
  }
}

final class FeedViewController: UIViewController, UICollectionViewDelegate {
  let model: ThreadDetailModel
  let status: FeedStatus
  var images: ThreadImages = .none
  var openThread: (String) -> Void = { _ in }
  private var rowEnvironment = FeedRowEnvironment()
  var reduceMotion = false

  private(set) var scroll: FeedScroll
  private var items: [String: FeedItem] = [:]
  private var order: [String] = []
  private var revision: Int?
  private var collection: FeedCollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  /// Set while this controller animates the feed to its end.
  private var adjusting = false
  private var insetsAnimating = false
  /// Set by a row toggle: the next update animates the resize it causes.
  private var animatesNextUpdate = false
  /// Rows that join the feed in view and fade in: a reader's new message, rows a fold opens.
  private var arriving: Set<String> = []
  #if DEBUG
    private var debugTop = ProcessInfo.processInfo.environment["ANKIEL_DEBUG_THREAD_SCROLL"] == "top"
  #endif

  init(model: ThreadDetailModel, status: FeedStatus) {
    self.model = model
    self.status = status
    scroll = FeedScroll(model.scrollAnchor)
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

  override func loadView() {
    let size = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(120))
    let section = NSCollectionLayoutSection(
      group: .vertical(layoutSize: size, subitems: [NSCollectionLayoutItem(layoutSize: size)]))
    section.contentInsets = NSDirectionalEdgeInsets(top: Spacing.sm, leading: 0, bottom: 0, trailing: 0)
    collection = FeedCollectionView(frame: .zero, collectionViewLayout: UICollectionViewCompositionalLayout(section: section))
    collection.backgroundColor = .clear
    collection.alwaysBounceVertical = true
    collection.showsHorizontalScrollIndicator = false
    collection.contentInsetAdjustmentBehavior = .never
    collection.keyboardDismissMode = .interactive
    collection.delegate = self
    // Hard at the top: the title sits over long-form text, which the soft edge left legible under it.
    collection.topEdgeEffect.style = .hard
    collection.bottomEdgeEffect.style = .soft
    collection.onLayout = { [weak self] in self?.layoutDidPass() }
    collection.onUserScroll = { [weak self] in self?.readerScrolled() }

    let registration = UICollectionView.CellRegistration<FeedCell, String> { [weak self] cell, _, id in
      guard let self, let item = items[id] else { return }
      cell.contentConfiguration = configuration(item)
      cell.backgroundConfiguration = .clear()
    }
    dataSource = UICollectionViewDiffableDataSource(collectionView: collection) { view, indexPath, id in
      view.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: id)
    }
    view = collection
  }

  private func configuration(_ item: FeedItem) -> some UIContentConfiguration {
    let content: AnyView =
      switch item {
      case .row(let row, let spacing, let expanded, let load):
        AnyView(
          TimelineRowView(
            row: row, expanded: expanded, load: load, images: images, model: model, openThread: openThread,
            toggle: { [weak self] key in self?.toggle(key, row: row.id) }
          )
          .equatable()
          .padding(.top, spacing)
          .column())
      case .pending(let row, let spacing):
        AnyView(PendingRowView(row: row).padding(.top, spacing).column())
      }
    let environment = rowEnvironment
    return UIHostingConfiguration { content.feedRowEnvironment(environment) }
      .margins(.all, 0)
  }

  // MARK: Updates

  /// Built cells keep the environment they were configured with, so a presenter that appears or
  /// changes after the first rows (the thread's hosts settle a render later) rebuilds them.
  func setRowEnvironment(_ next: FeedRowEnvironment) {
    let stale = next.needsReconfigure(from: rowEnvironment)
    rowEnvironment = next
    guard stale, dataSource != nil, !order.isEmpty else { return }
    var snapshot = dataSource.snapshot()
    snapshot.reconfigureItems(snapshot.itemIdentifiers)
    dataSource.apply(snapshot, animatingDifferences: false)
  }

  func setInsets(top: CGFloat, bottom: CGFloat) {
    let insets = UIEdgeInsets(top: top, left: 0, bottom: bottom, right: 0)
    guard collection.contentInset != insets else { return }
    collection.contentInset = insets
    collection.verticalScrollIndicatorInsets = insets
    insetsAnimating = true
    collection.animatesLayout = true
    defer {
      insetsAnimating = false
      collection.animatesLayout = false
    }
    collection.setNeedsLayout()
    collection.layoutIfNeeded()
  }

  func update(_ next: [FeedItem], revision next_revision: Int) {
    let previousPending = items.values.count { if case .pending = $0 { true } else { false } }
    let animates = animatesNextUpdate
    animatesNextUpdate = false
    let known = Set(order)
    arriving = Set(
      next.lazy.filter { item in
        guard !known.contains(item.id), !known.isEmpty else { return false }
        if case .pending = item { return true }
        return animates
      }.map(\.id))
    var changed: [String] = []
    var nextItems: [String: FeedItem] = [:]
    nextItems.reserveCapacity(next.count)
    for item in next {
      if let old = items[item.id], old != item { changed.append(item.id) }
      nextItems[item.id] = item
    }
    let nextOrder = next.map(\.id)
    items = nextItems
    if nextOrder != order {
      order = nextOrder
      var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
      snapshot.appendSections([0])
      snapshot.appendItems(nextOrder)
      snapshot.reconfigureItems(changed)
      dataSource.apply(snapshot, animatingDifferences: false)
    } else if !changed.isEmpty {
      var snapshot = dataSource.snapshot()
      snapshot.reconfigureItems(changed)
      dataSource.apply(snapshot, animatingDifferences: false)
    }

    #if DEBUG
      if debugTop, let first = order.first {
        debugTop = false
        scroll = FeedScroll(.row(first, offset: 0))
      }
    #endif
    if let revision, revision != next_revision { scroll.contentChanged() }
    revision = next_revision
    let pending = items.values.count { if case .pending = $0 { true } else { false } }
    if pending > previousPending {
      // The reader's own new message always comes into view.
      scrollToEnd(animated: true)
    } else if animates {
      animateResize()
    } else {
      collection.setNeedsLayout()
    }
    publish()
  }

  /// A toggled row resizes inside one short animation. The anchor is re-applied inside it too
  /// (as for an inset change), so the toggled row stays put while the rows after it move.
  private func animateResize() {
    insetsAnimating = true
    collection.animatesLayout = true
    UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState, .allowUserInteraction]) {
      self.collection.layoutIfNeeded()
    }
    insetsAnimating = false
    collection.animatesLayout = false
  }

  /// Back to the end (the scroll-to-latest button, or a send).
  func scrollToEnd(animated: Bool) {
    scroll.jumpToEnd()
    publish()
    collection.layoutIfNeeded()
    let target = collection.offsets.upperBound
    let distance = abs(target - collection.contentOffset.y)
    // A long way is a jump: an animated bounds change only lays out the destination, so the rows
    // in between would fly past blank.
    guard animated, !reduceMotion, distance > 1, distance < collection.bounds.height * 1.5 else {
      collection.setNeedsLayout()
      collection.layoutIfNeeded()
      return
    }
    adjusting = true
    UIView.animate(withDuration: 0.3, delay: 0, options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction]) {
      self.collection.contentOffset.y = target
      self.collection.layoutIfNeeded()
    } completion: { _ in
      self.adjusting = false
      self.collection.setNeedsLayout()
    }
  }

  private func toggle(_ key: String, row: String) {
    if let top = rowTop(row) {
      scroll.toggled(row, offset: top - collection.visibleTop)
    }
    animatesNextUpdate = !reduceMotion
    withAnimation(Motion.resolve(Motion.snappy, reduceMotion: reduceMotion)) { model.toggle(key) }
  }

  func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    guard let id = dataSource.itemIdentifier(for: indexPath), arriving.remove(id) != nil else { return }
    cell.alpha = 0
    if !reduceMotion { cell.transform = CGAffineTransform(translationX: 0, y: 8) }
    UIView.animate(withDuration: reduceMotion ? 0.15 : 0.25, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
      cell.alpha = 1
      cell.transform = .identity
    }
  }

  // MARK: Anchoring

  private func rowTop(_ id: String) -> Double? {
    guard let indexPath = dataSource.indexPath(for: id) else { return nil }
    return collection.collectionViewLayout.layoutAttributesForItem(at: indexPath).map { Double($0.frame.minY) }
  }

  /// Every layout pass (new rows, rows resizing, insets, rotation) ends here: put the anchor back
  /// before the frame is drawn. A few rounds, because rows that come on screen size themselves.
  private func layoutDidPass() {
    guard !collection.readerMoving, !adjusting, !order.isEmpty, collection.window != nil,
      collection.bounds.height > 0
    else { return }
    // A correction rides an inset change's animation (the keyboard, the composer), so the rows
    // move with it. Any other animation in flight (a push, a row opening) would otherwise animate
    // the correction too, and the feed visibly slid into place while the offset was already right.
    if insetsAnimating {
      applyAnchor()
    } else {
      UIView.performWithoutAnimation(applyAnchor)
    }
    scroll.settled(distanceToEnd: collection.offsets.upperBound - collection.contentOffset.y)
    publish()
  }

  private func applyAnchor() {
    for _ in 0..<4 {
      let insetTop = Double(collection.adjustedContentInset.top)
      guard let target = scroll.target(rowTop: { self.rowTop($0) }, insetTop: insetTop, range: collection.offsets),
        abs(target - Double(collection.contentOffset.y)) > 0.5
      else { break }
      collection.move(to: target)
    }
  }

  private func readerScrolled() {
    guard !adjusting else { return }
    scroll.scrolled(distanceToEnd: collection.offsets.upperBound - collection.contentOffset.y, top: topRow())
    publish()
  }

  /// The first row whose bottom is below the visible top, and its top's offset from it.
  private func topRow() -> (id: String, offset: Double)? {
    let top = collection.visibleTop
    let visible = collection.indexPathsForVisibleItems.sorted()
    for indexPath in visible {
      guard let frame = collection.collectionViewLayout.layoutAttributesForItem(at: indexPath)?.frame,
        frame.maxY > top + 1, let id = dataSource.itemIdentifier(for: indexPath)
      else { continue }
      return (id, frame.minY - top)
    }
    return nil
  }

  private func publish() {
    if model.scrollAnchor != scroll.anchor { model.scrollAnchor = scroll.anchor }
    if status.following != scroll.following { status.following = scroll.following }
    if status.unseen != scroll.unseen { status.unseen = scroll.unseen }
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    collection.didScroll()
  }

  func scrollViewDidScrollToTop(_ scrollView: UIScrollView) {
    readerScrolled()
  }

  func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
    collection.endExternalScroll()
  }
}

/// Reports where its layout passes end, and which offset changes are the reader's: a drag or
/// fling, or a scroll asked for on their behalf (VoiceOver, scroll-to-visible). UIKit also moves
/// the offset while it resizes content and insets; those are not the reader's.
final class FeedCollectionView: UICollectionView {
  var onLayout: () -> Void = {}
  var onUserScroll: () -> Void = {}
  private var externalScroll = false

  var readerMoving: Bool { isTracking || isDecelerating || externalScroll }

  var visibleTop: Double { Double(contentOffset.y + adjustedContentInset.top) }

  /// The scroll offsets from the top of the feed to its end.
  var offsets: ClosedRange<Double> {
    let start = Double(-adjustedContentInset.top)
    let end = Double(contentSize.height + adjustedContentInset.bottom - bounds.height)
    return start...max(start, end)
  }

  /// Set while an inset change (keyboard, composer) lays the feed out inside its animation.
  var animatesLayout = false

  override func layoutSubviews() {
    // Rows resizing inside some other animation in flight (a push, SwiftUI's transaction for a
    // row toggle) would otherwise slide into place from where they were estimated.
    if animatesLayout {
      super.layoutSubviews()
    } else {
      UIView.performWithoutAnimation { super.layoutSubviews() }
    }
    onLayout()
  }

  /// Moves the feed and lays out the rows that come on screen (they size themselves).
  func move(to y: Double) {
    contentOffset.y = y
    super.layoutSubviews()
  }

  override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
    externalScroll = true
    defer { externalScroll = false }
    let scrolled = super.accessibilityScroll(direction)
    onUserScroll()
    return scrolled
  }

  override func scrollRectToVisible(_ rect: CGRect, animated: Bool) {
    externalScroll = true
    super.scrollRectToVisible(rect, animated: animated)
    if !animated || !isScrollAnimating { endExternalScroll() }
  }

  func didScroll() {
    if readerMoving { onUserScroll() }
  }

  func endExternalScroll() {
    guard externalScroll else { return }
    externalScroll = false
    onUserScroll()
  }
}

/// A feed row. It reports no safe area: the feed runs under the bars and the composer and insets
/// itself by them, and a hosted row under a bar was otherwise padded by the part it overlapped, a
/// padding that changed as it scrolled, so rows slid under the finger by up to the bar's height.
final class FeedCell: UICollectionViewCell {
  override var safeAreaInsets: UIEdgeInsets { .zero }

  override init(frame: CGRect) {
    super.init(frame: frame)
    // An opening row grows over the rows below while they move down: clip it to its frame.
    clipsToBounds = true
  }

  @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

  override func prepareForReuse() {
    super.prepareForReuse()
    alpha = 1
    transform = .identity
  }
}

extension View {
  /// The reading column, centered in the feed's full width.
  fileprivate func column() -> some View {
    padding(.horizontal, Spacing.lg + 2)
      .frame(maxWidth: Layout.readingWidth, alignment: .leading)
      .frame(maxWidth: .infinity)
  }
}
