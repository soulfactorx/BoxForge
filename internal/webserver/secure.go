package webserver

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The password is kept as a salted, slow hash: reading the file does not
// give the password away.
type stored struct {
	Salt string `json:"salt"`
	Hash string `json:"hash"`
}

const rounds = 600_000

func hash(password string, salt []byte) []byte {
	key, _ := pbkdf2.Key(sha256.New, password, salt, rounds, 32)
	return key
}

// Passwords keeps the server's password in dir.
type Passwords struct{ file string }

// PasswordsIn returns the password kept in dir.
func PasswordsIn(dir string) Passwords { return Passwords{filepath.Join(dir, "server-password.json")} }

// Set stores a new password.
func (p Passwords) Set(password string) error {
	if len(password) < 8 {
		return errors.New("the password needs at least 8 characters")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	b, _ := json.Marshal(stored{Salt: hex.EncodeToString(salt), Hash: hex.EncodeToString(hash(password, salt))})
	if err := os.MkdirAll(filepath.Dir(p.file), 0o700); err != nil {
		return err
	}
	return os.WriteFile(p.file, b, 0o600)
}

// Exists reports whether a password has been set.
func (p Passwords) Exists() bool {
	_, err := os.Stat(p.file)
	return err == nil
}

// Check reports whether password is the one stored.
func (p Passwords) Check(password string) bool {
	b, err := os.ReadFile(p.file)
	if err != nil {
		return false
	}
	var s stored
	if json.Unmarshal(b, &s) != nil {
		return false
	}
	salt, err1 := hex.DecodeString(s.Salt)
	want, err2 := hex.DecodeString(s.Hash)
	if err1 != nil || err2 != nil || len(want) == 0 {
		return false
	}
	return SameSecret(hash(password, salt), want)
}

// Generate makes up a password, stores it and returns it: to be shown
// once, to whoever started the server.
func (p Passwords) Generate() (string, error) {
	// Letters and digits that are not mistaken for one another when typed
	// from one screen into another.
	const letters = "abcdefghjkmnpqrstuvwxyz23456789"
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	var b strings.Builder
	for i, c := range raw {
		if i > 0 && i%5 == 0 {
			b.WriteByte('-')
		}
		b.WriteByte(letters[int(c)%len(letters)])
	}
	return b.String(), p.Set(b.String())
}

// Certificate returns the server's own certificate, kept in dir, making
// one the first time. It is signed by nobody: a browser warns before the
// first visit, and what proves the server is its fingerprint, returned
// here to be compared with the one the browser shows.
func Certificate(dir string) (tls.Certificate, string, error) {
	certFile, keyFile := filepath.Join(dir, "server-cert.pem"), filepath.Join(dir, "server-key.pem")
	if cert, err := tls.LoadX509KeyPair(certFile, keyFile); err == nil {
		if leaf, err := x509.ParseCertificate(cert.Certificate[0]); err == nil && time.Now().Before(leaf.NotAfter.AddDate(0, -1, 0)) {
			return cert, fingerprint(cert.Certificate[0]), nil
		}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	host, _ := os.Hostname()
	tmpl := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: "BoxForge on " + host},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(2, 0, 0),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}
	if host != "" {
		tmpl.DNSNames = append(tmpl.DNSNames, host)
	}
	// Every address this machine has: the phone will use one of them.
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() {
				tmpl.IPAddresses = append(tmpl.IPAddresses, n.IP)
			}
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return tls.Certificate{}, "", err
	}
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return tls.Certificate{}, "", err
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		return tls.Certificate{}, "", err
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	return cert, fingerprint(der), err
}

// fingerprint is a certificate's SHA-256, written as browsers show it.
func fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = strings.ToUpper(hex.EncodeToString([]byte{b}))
	}
	return strings.Join(parts, ":")
}
