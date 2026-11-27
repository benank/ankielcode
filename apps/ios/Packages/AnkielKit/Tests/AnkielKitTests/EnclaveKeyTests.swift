import CryptoKit
import Foundation
import Testing

@testable import AnkielKit

/// New pairings bind to a Secure Enclave key when the device has one; existing sessions keep the
/// software key they were paired with, and any enclave failure falls back to it.
@Suite("Secure Enclave keys")
struct EnclaveKeyTests {
  struct FailingEnclave: EnclaveKeys {
    var isAvailable: Bool
    func make() throws -> DPoPKey { throw EnclaveKeyError.missing }
    func restore(_: Data) throws -> DPoPKey { throw EnclaveKeyError.missing }
  }

  @Test("no enclave, or a failing one: new pairings use the software key and record nothing")
  func fallback() throws {
    for enclave in [FailingEnclave(isAvailable: false), FailingEnclave(isAvailable: true)] {
      let store = InMemoryCredentialStore()
      let software = try store.dpopKey()
      let key = try store.pairingKey(enclave: enclave)
      #expect(!key.isHardwareBacked)
      #expect(key.thumbprint == software.thumbprint)
      try store.bind("env-new", to: key)
      #expect(store.data(for: CredentialKeys.keyKind("env-new")) == nil)
      #expect(try store.dpopKey(for: "env-new", enclave: enclave).thumbprint == software.thumbprint)
    }
  }

  @Test("an environment marked for the enclave whose key is gone fails instead of using another key")
  func missingEnclaveKey() throws {
    let store = InMemoryCredentialStore()
    store.set(Data(DPoPKeyKind.enclave.rawValue.utf8), for: CredentialKeys.keyKind("env-1"))
    #expect(throws: (any Error).self) { try store.dpopKey(for: "env-1", enclave: FailingEnclave(isAvailable: true)) }
  }

  @Test("with a real Secure Enclave: new pairings bind to it, old ones keep the software key", .enabled(if: SecureEnclave.isAvailable))
  func realEnclave() throws {
    let store = InMemoryCredentialStore()
    let software = try store.dpopKey()
    let enclave = SystemEnclaveKeys()
    let key: DPoPKey
    do {
      key = try store.pairingKey(enclave: enclave)
    } catch {
      Issue.record("pairing key failed: \(error)")
      return
    }
    // An unsigned test runner may be refused the enclave; the fallback is then what we expect.
    guard key.isHardwareBacked else {
      #expect(key.thumbprint == software.thumbprint)
      return
    }
    try store.bind("env-enclave", to: key)
    let restored = try store.dpopKey(for: "env-enclave", enclave: enclave)
    #expect(restored.isHardwareBacked && restored.thumbprint == key.thumbprint)
    #expect(try store.dpopKey(for: "env-legacy", enclave: enclave).thumbprint == software.thumbprint)
    // The same installation key serves the next pairing.
    #expect(try store.pairingKey(enclave: enclave).thumbprint == key.thumbprint)

    // Its proofs verify against the public JWK the server sees.
    let proof = try restored.proof(method: "POST", url: URL(string: "https://host.example.com/oauth/token")!)
    let parts = proof.split(separator: ".").map(String.init)
    let jwk = restored.publicJWK
    let x = try #require(Data(base64URLEncoded: jwk.x)), y = try #require(Data(base64URLEncoded: jwk.y))
    let publicKey = try P256.Signing.PublicKey(x963Representation: Data([4]) + x + y)
    let signature = try P256.Signing.ECDSASignature(rawRepresentation: try #require(Data(base64URLEncoded: parts[2])))
    #expect(publicKey.isValidSignature(signature, for: Data("\(parts[0]).\(parts[1])".utf8)))

    // Forgetting the environment drops its binding.
    try store.bind("env-enclave", to: nil)
    #expect(try store.dpopKey(for: "env-enclave", enclave: enclave).thumbprint == software.thumbprint)
  }
}
