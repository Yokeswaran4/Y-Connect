// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.util.Base64
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/** AES-256-GCM, key = PBKDF2-SHA256(pairing code). Wire format: base64(iv[12] + ciphertext + tag[16]). */
object Crypto {
    private val rnd = SecureRandom()

    fun normalize(p: String): String =
        p.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }.ifEmpty { "-" }

    fun deriveKey(pass: String): ByteArray {
        val spec = PBEKeySpec(normalize(pass).toCharArray(), "y-connect-v1".toByteArray(), 100000, 256)
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    }

    fun encrypt(key: ByteArray, plain: String): String {
        val iv = ByteArray(12).also { rnd.nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        val ct = c.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(iv + ct, Base64.NO_WRAP)
    }

    /** Binary frames (file data): iv[12] + ciphertext + tag[16], same cipher as the text frames, no base64. */
    fun encryptBytes(key: ByteArray, data: ByteArray, off: Int, len: Int): ByteArray {
        val iv = ByteArray(12).also { rnd.nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        val out = ByteArray(12 + c.getOutputSize(len))
        System.arraycopy(iv, 0, out, 0, 12)
        c.doFinal(data, off, len, out, 12)
        return out
    }

    fun decryptBytes(key: ByteArray, b: ByteArray): ByteArray {
        require(b.size > 28) { "short" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, b.copyOfRange(0, 12)))
        return c.doFinal(b, 12, b.size - 12)
    }

    fun decrypt(key: ByteArray, b64: String): String {
        val b = Base64.decode(b64, Base64.DEFAULT)
        require(b.size > 28) { "short" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, b.copyOfRange(0, 12)))
        return String(c.doFinal(b, 12, b.size - 12), Charsets.UTF_8)
    }
}
