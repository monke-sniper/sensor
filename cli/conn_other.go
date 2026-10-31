//go:build !windows

package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
)

func dial(path string) (io.ReadWriteCloser, error) {
	return net.Dial("unix", path)
}

func defaultSocket() string {
	if s := os.Getenv("SENSOR_SOCKET"); s != "" {
		return s
	}
	base := os.Getenv("XDG_RUNTIME_DIR")
	if base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, fmt.Sprintf("sensor-%d.sock", os.Getuid()))
}
