import express       from "express"
import bodyParser    from "body-parser"
import cookieSession from "cookie-session"
import cookieParser  from "cookie-parser"
import crypto        from "crypto"
import cbor          from "cbor"
import { b64enc, b64dec } from "./static/js/base64"

const RPID    = process.env.RPID
const ORIGIN  = process.env.ORIGIN
const PORT    = process.env.PORT
const app     = express()
const storage = new Map()

// middleware
app.use(cookieParser())
app.use(cookieSession({ name: "session", keys: [crypto.randomBytes(32)] }))
app.use(bodyParser.json())
app.use(express.static(new URL("static", import.meta.url).pathname))
app.use((req, res, next) => {
  // console.error("\n", req.path, req.session, req.body, "\n")
  next()
})


// GET /session
app.get("/session", (req, res) => {
  const username = req.session.username

  // check user in session or not
  if (username && storage.has(username)) {
    return res.json({username})
  }

  return res.status(404).json({})
})

// DELETE /session
app.delete("/session", (req, res) => {
  // clear session
  delete req.session.username
  //res.append("Clear-Site-Data", `"cache", "cookie", "storage"`)
  res.send()
})


// GET /credential/new
app.get("/credential/new", (req, res) => {
  const username  = req.query.username

  // identity for credential
  // assume that username is unique in service
  const id = username

  // random bytes for challenge
  const challenge = b64enc(crypto.randomBytes(32))

  storage.set(id, {
    username,
    authenticators: new Map()
  })

  // https://w3c.github.io/webauthn/#dictionary-makecredentialoptions
  const clientCredentialOption = {
    rp: {
      id:   RPID,
      name: RPID,
    },
    user: {
      id,
      name: username,
      displayName: username,
    },
    challenge: challenge,
    pubKeyCredParams: [ // acceptable credential
      {type: "public-key", alg: -7 /*ES256*/}
    ],
    attestation: "direct", // request attestation generated by authenticator
  }
  // console.log("clientCredentialOption", clientCredentialOption)

  // saving challenge for later use
  req.session.challenge = challenge
  req.session.username  = username // CAUTION!! this is only a sample
  res.json(clientCredentialOption)
})


// https://w3c.github.io/webauthn/#registering-a-new-credential
app.post("/credential", async (req, res) => {
  // decode
  const attestationObject = b64dec(req.body.response.attestationObject)
  const clientDataJSON    = b64dec(req.body.response.clientDataJSON)

  // 1. Let JSONtext be the result of running UTF-8 decode on the value of response.clientDataJSON.
  const JSONtext = Buffer.from(clientDataJSON).toString("utf-8")

  // 必ず JSON としてパースしてからプロパティを確認する
  // 全体の文字列一致で比較するとプロパティが追加された時壊れる
  // chrome はダミーのデータを入れてこれを防いでいる
  // 2. Let C, the client data claimed as collected during the credential creation,
  //    be the result of running an implementation-specific JSON parser on JSONtext.
  const C = JSON.parse(JSONtext)
  // console.log(C)

  // 3. Verify that the value of C.type is webauthn.create.
  console.assert(C.type === "webauthn.create", "invalid type")

  // 4. Verify that the value of C.challenge matches the challenge
  //    that was sent to the authenticator in the create() call.
  console.assert(C.challenge === req.session.challenge, "invalid challenge")

  // 5. Verify that the value of C.origin matches the Relying Party's origin.
  console.assert(C.origin === ORIGIN, "invalid origin")

  // 6. Verify that the value of C.tokenBinding.status matches the state of Token Binding
  //    for the TLS connection over which the assertion was obtained.
  //    If Token Binding was used on that TLS connection,
  //    also verify that C.tokenBinding.id matches the base64url encoding of the Token Binding ID for the connection.
  if (C.tokenBinding) console.assert(C.tokenBinding.status === "not-supported", "invalid token binding status")

  // 7. Compute the hash of response.clientDataJSON using SHA-256.
  const clientDataHash = crypto.createHash("sha256").update(clientDataJSON).digest()

  // 8. Perform CBOR decoding on the attestationObject field of the AuthenticatorAttestationResponse
  //    structure to obtain the attestation statement format fmt, the authenticator data authData,
  //    and the attestation statement attStmt.
  const {fmt, authData, attStmt} = (await cbor.decodeAll(Buffer.from(attestationObject))).shift()


  // +------------------------------------------+
  // | RPID hash (32) | Flags (1) | Counter (4) |
  // +------------------------------------------+
  // | authData                                 |
  // +------------------------------------------+
  const rpidHash = authData.slice( 0, 32)
  const flag     = authData.slice(32, 33).readUInt8(0)
  const counter  = authData.slice(33, 37).readUInt32BE(0)
  // console.log({rpidHash, flag, counter})

  // flag = [ED, AT, -, -, -, UV, -, UP] https://w3c.github.io/webauthn/#flags
  const UserPresent            = (flag & (2**0)) >> 0
  const UserVerified           = (flag & (2**2)) >> 2
  const AttestedCredentialData = (flag & (2**6)) >> 6
  const ExtensionDataIncluded  = (flag & (2**7)) >> 7
  // console.log({
  //   UserPresent,
  //   UserVerified,
  //   AttestedCredentialData,
  //   ExtensionDataIncluded,
  // })


  // parse result of authData
  const authenticatorData = {
    rpidHash,
    flags: {
      UserPresent,
      UserVerified,
      AttestedCredentialData,
      ExtensionDataIncluded,
    },
    counter
  }

  if (AttestedCredentialData) {
    // https://w3c.github.io/webauthn/#sec-attested-credential-data
    // +----------------------------------------+
    // | AAGUID (16)                            |
    // +----------------------------------------+
    // | CredID Len (2) | CredID                |
    // +----------------------------------------+
    // | CredentialPublicKey                    |
    // +----------------------------------------+
    const aaguid              = authData.slice(37, 53)
    const credentialIdLength  = authData.slice(53, 55).readUInt16BE(0)
    const credentialId        = authData.slice(55, 55 + credentialIdLength)
    const credentialPublicKey = (await cbor.decodeAll(authData.slice(55 + credentialIdLength))).shift()

    // console.log({
    //   aaguid,
    //   credentialIdLength,
    //   credentialId,
    //   credentialPublicKey
    // })

    const kty = credentialPublicKey.get(1)
    const alg = credentialPublicKey.get(3)
    const crv = credentialPublicKey.get(-1)
    const x = credentialPublicKey.get(-2)
    const y = credentialPublicKey.get(-3)

    // console.log({
    //   kty,
    //   alg,
    //   crv,
    //   x,
    //   y
    // })

    // [0x40, xcoord, ycoord] https://w3c.github.io/webauthn/#fido-u2f-attestation
    const publicKeyU2F = new Uint8Array(1 + x.length + y.length)
    publicKeyU2F[0] = 0x04
    publicKeyU2F.set(x, 1)
    publicKeyU2F.set(y, 1+x.length)

    authenticatorData.attestedCredentialData = {
      aaguid,
      credentialId,
      credentialPublicKey: {
        kty,
        alg,
        crv,
        x,
        y
      },
      publicKeyU2F
    }
  }


  // 9. Verify that the RP ID hash in authData is indeed the SHA-256 hash of the RP ID expected by the RP.
  console.assert(b64enc(rpidHash) ===  b64enc(crypto.createHash("sha256").update(RPID).digest()), "invalid rpid hash")

  // 10. Verify that the User Present bit of the flags in authData is set.
  console.assert(UserPresent === 1, "invalid UserPresent")

  // 11. If user verification is required for this registration,
  //     verify that the User Verified bit of the flags in authData is set.
  console.assert(UserVerified === 0, "invalid UserVerified")

  // 12. Verify that the values of the client extension outputs
  console.assert(ExtensionDataIncluded === 0, "invalid ExtensionDataIncluded")

  // 13. Determine the attestation statement format by performing a USASCII case-sensitive match on fmt
  console.assert(fmt === "fido-u2f", "unsupported") // support only fido-u2f

  // 14. Verify that attStmt is a correct attestation statement,
  //     conveying a valid attestation signature,
  //     by using the attestation statement format
  const verified = fido_u2f_verification_procedure(attStmt, authenticatorData, clientDataHash)
  console.assert(verified, "valification failed")
  if (!verified) {
    return res.json({
      message: "Can not authenticate signature!"
    })
  }

  // 15. If validation is successful, obtain a list of acceptable trust anchors
  // TODO:

  // 16. Assess the attestation trustworthiness using the outputs of the verification procedure
  //     in step 14, as follows:
  // TODO:


  // 17. Check that the credentialId is not yet registered to any other user.
  //     If registration is requested for a credential that is already registered to a different user,
  //     the Relying Party SHOULD fail this registration ceremony,
  //     or it MAY decide to accept the registration,
  // TODO:


  // 18. If the attestation statement attStmt verified successfully
  //     and is found to be trustworthy,
  //     then register the new credential with the account
  //     that was denoted in the options.user passed to create(),
  //     by associating it with the credentialId and credentialPublicKey
  //     in the attestedCredentialData in authData,
  //     as appropriate for the Relying Party's system.
  // TODO:

  const credentialId = b64enc(authenticatorData.attestedCredentialData.credentialId)
  const publicKey    = b64enc(authenticatorData.attestedCredentialData.publicKeyU2F) // use publickKeyU2F instead of raw credentialPublicKey

  const authenticatorInfo = {
    credentialId,
    publicKey,
    counter,
  }

  const username = req.session.username
  delete req.session.challenge
  const userinfo = storage.get(username)
  userinfo.authenticators.set(credentialId, authenticatorInfo)
  storage.set(username, userinfo)
  res.json({ status: "registered" })
})


app.get("/session/new", (req, res) => {
  const username = req.query.username
  if (!storage.has(username)) {
    return res.status(404).json({})
  }

  const challenge = b64enc(crypto.randomBytes(32))

  const authenticators = storage.get(username).authenticators
  const allowCredentials = Array.from(authenticators.keys()).map((id) => {
    return {
      type: "public-key",
      id,
    }
  })
  // console.log(allowCredentials)

  const clientCredentialOption = {
    challenge,
    allowCredentials
  }

  req.session.username  = username // CAUTION!! this is only a sample
  req.session.challenge = challenge
  res.json(clientCredentialOption)
})


// https://w3c.github.io/webauthn/#verifying-assertion
app.post("/session", (req, res) => {
  const credential = req.body
  const id = credential.id

  const authenticators = storage.get(req.session.username).authenticators


  // 1. If the allowCredentials option was given
  //    when this authentication ceremony was initiated,
  //    verify that credential.id identifies one of the public key
  //    credentials that were listed in allowCredentials.
  // TODO


  // 2. If credential.response.userHandle is present
  if (credential.response.userHandle) {
    // verify that the user identified by this value is the
    // owner of the public key credential identified by credential.id.
    // TODO
  }

  // 3. Using credential's id attribute
  //   (or the corresponding rawId, if base64url encoding is inappropriate for your use case),
  //   look up the corresponding credential public key.
  const authenticate = authenticators.get(id)


  // 4. Let cData, authData and sig denote the value of credential's response's
  //    clientDataJSON, authenticatorData, and signature respectively.
  const cData    = Buffer.from(b64dec(credential.response.clientDataJSON))
  const authData = Buffer.from(b64dec(credential.response.authenticatorData))
  const sig      = Buffer.from(b64dec(credential.response.signature))


  // 5. Let JSONtext be the result of running UTF-8 decode on the value of cData.
  const JSONtext = Buffer.from(cData).toString("utf-8")

  // 6. Let C, the client data claimed as used for the signature,
  //    be the result of running an implementation-specific JSON parser on JSONtext.
  const C = JSON.parse(JSONtext)

  // 7. Verify that the value of C.type is the string webauthn.get.
  console.assert(C.type === "webauthn.get", "invalid type")

  // 8. Verify that the value of C.challenge matches the challenge
  //    that was sent to the authenticator in the PublicKeyCredentialRequestOptions
  //    passed to the get() call.
  console.assert(C.challenge === req.session.challenge, "invalid challenge")

  // 9. Verify that the value of C.origin matches the Relying Party's origin.
  console.assert(C.origin === ORIGIN, "invalid origin")

  // 10. Verify that the value of C.tokenBinding.status matches the state of
  //     Token Binding for the TLS connection over which the attestation was obtained.
  //     If Token Binding was used on that TLS connection,
  //     also verify that C.tokenBinding.id matches the base64url encoding of the Token Binding ID for the connection.
  if (C.tokenBinding) console.assert(C.tokenBinding.status === "not-supported", "invalid token binding status")


  // +------------------------------------------+
  // | RPID hash (32) | Flags (1) | Counter (4) |
  // +------------------------------------------+
  // | authData                                 |
  // +------------------------------------------+
  const rpidHash  = authData.slice( 0, 32)
  const flags     = authData.slice(32, 33).readUInt8(0)
  const signCount = authData.slice(33, 37).readUInt32BE(0)
  // console.log({rpidHash, flag, signCount})

  // flag = [ED, AT, -, -, -, UV, -, UP] https://w3c.github.io/webauthn/#flags
  const UserPresent            = (flags & (2**0)) >> 0
  const UserVerified           = (flags & (2**2)) >> 2
  const AttestedCredentialData = (flags & (2**6)) >> 6
  const ExtensionDataIncluded  = (flags & (2**7)) >> 7
  // console.log({
  //   UserPresent,
  //   UserVerified,
  //   AttestedCredentialData,
  //   ExtensionDataIncluded,
  // })


  // 11. Verify that the rpIdHash in authData is the SHA-256 hash of the RP ID expected by the Relying Party.
  console.assert(b64enc(rpidHash) === b64enc(crypto.createHash("sha256").update(RPID).digest()), "invalid rpdi hash")

  // 12. Verify that the User Present bit of the flags in authData is set.
  console.assert(UserPresent === 1, "invalid UserPresent")

  // 13. If user verification is required for this assertion,
  //     verify that the User Verified bit of the flags in authData is set.
  console.assert(UserVerified === 0, "invalid UserVerified")

  // 14. Verify that the values of the client extension outputs in clientExtensionResults
  //     and the authenticator extension outputs in the extensions in authData are as expected
  // TODO


  // 15. Let hash be the result of computing a hash over the cData using SHA-256.
  const hash = crypto.createHash("sha256").update(cData).digest()
  // console.log(hash)


  // https://github.com/fido-alliance/webauthn-demo/blob/master/utils.js
  // https://stackoverflow.com/questions/45131935/export-an-elliptic-curve-key-from-ios-to-work-with-openssl
  //
  // If needed, we encode rawpublic key to ASN structure, adding metadata:
  // SEQUENCE {
  //   SEQUENCE {
  //      OBJECTIDENTIFIER 1.2.840.10045.2.1 (ecPublicKey)
  //      OBJECTIDENTIFIER 1.2.840.10045.3.1.7 (P-256)
  //   }
  //   BITSTRING <raw public key>
  // }
  // Luckily, to do that, we just need to prefix it with constant 26 bytes (metadata is constant).
  const publick_key = Buffer.concat([
    Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
    Buffer.from(b64dec(authenticate.publicKey)),
  ]).toString("base64").match(/.{1,64}/g)

  const pem = [
    "-----BEGIN PUBLIC KEY-----",
    ...publick_key,
    "-----END PUBLIC KEY-----",
  ].join("\n")
  // console.log(pem)


  // 16. Using the credential public key looked up in step 3,
  //     verify that sig is a valid signature over the binary concatenation of authData and hash.
  const verified = crypto.createVerify("sha256").update(Buffer.concat([authData, hash])).verify(pem, sig)
  if (!verified) {
    return res.json({
      message: "Can not authenticate signature!"
    })
  }

  // 17. If the signature counter value authData.signCount is nonzero
  //     or the value stored in conjunction with credential's id attribute is nonzero,
  if (signCount !== 0 && authenticate.counter !== 0) {
    // TODO:  then run the following sub-step:
    console.log(signCount, authenticate.counter)
  }

  delete req.session.challenge

  res.json({status: "authenticated"})
})


app.use((err, req, res, next) => {
  console.error(`==============\n${err}\n==============\n`)
  res.status(500)
})

app.listen(PORT)
console.log("server start\n\n")


// https://w3c.github.io/webauthn/#verification-procedure
// https://w3c.github.io/webauthn/#fido-u2f-attestation
function fido_u2f_verification_procedure(attStmt, authenticatorData, clientDataHash) {
  // 1. Verify that attStmt is valid CBOR conforming to the syntax defined above
  //    and perform CBOR decoding on it to extract the contained fields.
  //      u2fStmtFormat = {
  //        x5c: [ attestnCert: bytes ],
  //        sig: bytes
  //      }
  console.assert(attStmt.x5c)
  console.assert(attStmt.sig)

  // 2. Check that x5c has exactly one element
  console.assert(attStmt.x5c.length === 1)

  //    and let attCert be that element.
  const attCert = attStmt.x5c[0]
  // console.log({attCert})

  // TODO
  //    Let certificate public key be the public key conveyed by attCert.
  //    If certificate public key is not an Elliptic Curve (EC) public key over the P-256 curve,
  //    terminate this algorithm and return an appropriate error.


  // 3. Extract the claimed rpIdHash from authenticatorData,
  //    and the claimed credentialId and credentialPublicKey
  //    from authenticatorData.attestedCredentialData.
  const {rpidHash} = authenticatorData
  const {credentialId, credentialPublicKey, publicKeyU2F} = authenticatorData.attestedCredentialData

  // 4. Convert the COSE_KEY formatted credentialPublicKey (see Section 7 of  [RFC8152])
  //    to Raw ANSI X9.62 public key format
  //    (see ALG_KEY_ECC_X962_RAW in Section 3.6.2 Public Key Representation Formats of [FIDO-Registry]).

  // wrapping by 64 chars of base64 of attStmt.x5c
  // adding Header/Footer for make it PEM format
  const certificatePublicKeyPEM = [
    "-----BEGIN CERTIFICATE-----",
    ...(attCert.toString("base64").match(/.{1,64}/g)),
    "-----END CERTIFICATE-----",
  ].join("\n")
  // console.log(certificatePublicKeyPEM)

  // 5. Let verificationData be the concatenation of
  //    (0x00 || rpIdHash || clientDataHash || credentialId || publicKeyU2F)
  //    (see Section 4.3 of  [FIDO-U2F-Message-Formats]).
  const verificationData  = Buffer.concat([
    Buffer.from([0x00]),
    rpidHash,
    clientDataHash,
    credentialId,
    publicKeyU2F,
  ])
  // console.log({verificationData})

  // 6. Verify the sig using verificationData and certificate public key per  [SEC1].
  const verified = crypto.createVerify("sha256").update(verificationData).verify(certificatePublicKeyPEM, attStmt.sig)

  // 7. If successful, return attestation type Basic with the attestation trust path set to x5c.
  // TODO

  return verified
}
