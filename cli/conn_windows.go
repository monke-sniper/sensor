//go:build windows

package main

import (
	"io"
	"os"
	"time"
)

// Named pipes are opened as files on Windows (CreateFile); byte-mode pipes
// created by Node's net server work with plain reads and writes.
func dial(path string) (io.ReadWriteCloser, error) {
	var lastErr error
	for i := 0; i < 20; i++ {
		f, err := os.OpenFile(path, os.O_RDWR, 0)
		if err == nil {
			return f, nil
		}
		lastErr = err
		time.Sleep(50 * time.Millisecond) // ERROR_PIPE_BUSY: all instances busy, retry
	}
	return nil, lastErr
}

func defaultSocket() string {
	if s := os.Getenv("SENSOR_SOCKET"); s != "" {
		return s
	}
	return `\\.\pipe\sensor-` + os.Getenv("USERNAME")
}
