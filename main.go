package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
)

//go:embed static/*
var staticEmbedFS embed.FS

var (
	statusHistory      []*SystemStatus
	statusHistoryLimit = 40
	historyMutex       sync.RWMutex
)

type BatteryInfo struct {
	HasBattery bool    `json:"hasBattery"`
	Percent    float64 `json:"percent"`
	Status     string  `json:"status"`
}

type NetworkInfo struct {
	BytesSent uint64 `json:"bytesSent"`
	BytesRecv uint64 `json:"bytesRecv"`
}

type SystemStatus struct {
	CPU struct {
		ModelName   string    `json:"modelName"`
		Cores       int       `json:"cores"`
		Usage       float64   `json:"usage"`
		UsagePerCore []float64 `json:"usagePerCore"`
	} `json:"cpu"`
	Memory struct {
		Total     uint64  `json:"total"`
		Available uint64  `json:"available"`
		Used      uint64  `json:"used"`
		Percent   float64 `json:"percent"`
	} `json:"memory"`
	Disk struct {
		Total   uint64  `json:"total"`
		Free    uint64  `json:"free"`
		Used    uint64  `json:"used"`
		Percent float64 `json:"percent"`
	} `json:"disk"`
	Battery BatteryInfo `json:"battery"`
	Network NetworkInfo `json:"network"`
	Host    struct {
		Hostname        string `json:"hostname"`
		OS              string `json:"os"`
		Platform        string `json:"platform"`
		KernelVersion   string `json:"kernelVersion"`
		Uptime          uint64 `json:"uptime"`
		BootTime        uint64 `json:"bootTime"`
		Procs           uint64 `json:"procs"`
	} `json:"host"`
	Timestamp int64 `json:"timestamp"`
}

func getBatteryInfo() BatteryInfo {
	var info BatteryInfo
	basePath := "/sys/class/power_supply"

	// Find battery directory (usually starts with BAT)
	files, err := os.ReadDir(basePath)
	if err != nil {
		info.HasBattery = false
		return info
	}

	var batDir string
	for _, f := range files {
		if strings.HasPrefix(f.Name(), "BAT") {
			batDir = filepath.Join(basePath, f.Name())
			break
		}
	}

	if batDir == "" {
		info.HasBattery = false
		return info
	}

	info.HasBattery = true

	// Read capacity (percent)
	capBytes, err := os.ReadFile(filepath.Join(batDir, "capacity"))
	if err == nil {
		capStr := strings.TrimSpace(string(capBytes))
		if capVal, err := strconv.ParseFloat(capStr, 64); err == nil {
			info.Percent = capVal
		}
	}

	// Read status
	statusBytes, err := os.ReadFile(filepath.Join(batDir, "status"))
	if err == nil {
		info.Status = strings.TrimSpace(string(statusBytes))
	} else {
		info.Status = "Unknown"
	}

	return info
}

func getSystemStatus() (*SystemStatus, error) {
	status := &SystemStatus{}
	status.Timestamp = time.Now().Unix()

	// 1. CPU
	cpuModel := "Unknown"
	cpuInfo, err := cpu.Info()
	if err == nil && len(cpuInfo) > 0 {
		cpuModel = cpuInfo[0].ModelName
	}
	status.CPU.ModelName = cpuModel
	status.CPU.Cores, _ = cpu.Counts(true)

	// CPU Usage
	percent, err := cpu.Percent(0, false)
	if err == nil && len(percent) > 0 {
		status.CPU.Usage = percent[0]
	}
	perCore, err := cpu.Percent(0, true)
	if err == nil {
		status.CPU.UsagePerCore = perCore
	}

	// 2. Memory
	vMem, err := mem.VirtualMemory()
	if err == nil {
		status.Memory.Total = vMem.Total
		status.Memory.Available = vMem.Available
		status.Memory.Used = vMem.Used
		status.Memory.Percent = vMem.UsedPercent
	}

	// 3. Disk (Root directory "/")
	dUsage, err := disk.Usage("/")
	if err == nil {
		status.Disk.Total = dUsage.Total
		status.Disk.Free = dUsage.Free
		status.Disk.Used = dUsage.Used
		status.Disk.Percent = dUsage.UsedPercent
	}

	// 4. Battery
	status.Battery = getBatteryInfo()

	// 5. Host Info
	hInfo, err := host.Info()
	if err == nil {
		status.Host.Hostname = hInfo.Hostname
		status.Host.OS = hInfo.OS
		status.Host.Platform = hInfo.Platform
		status.Host.KernelVersion = hInfo.KernelVersion
		status.Host.Uptime = hInfo.Uptime
		status.Host.BootTime = hInfo.BootTime
	}

	// 6. Network Info
	netIO, err := net.IOCounters(false)
	if err == nil && len(netIO) > 0 {
		status.Network.BytesSent = netIO[0].BytesSent
		status.Network.BytesRecv = netIO[0].BytesRecv
	}

	return status, nil
}

func startStatusCollector() {
	ticker := time.NewTicker(2 * time.Second)
	
	// Initial population
	if s, err := getSystemStatus(); err == nil {
		historyMutex.Lock()
		statusHistory = append(statusHistory, s)
		historyMutex.Unlock()
	}

	go func() {
		for range ticker.C {
			s, err := getSystemStatus()
			if err != nil {
				continue
			}
			historyMutex.Lock()
			if len(statusHistory) >= statusHistoryLimit {
				statusHistory = statusHistory[1:]
			}
			statusHistory = append(statusHistory, s)
			historyMutex.Unlock()
		}
	}()
}

func main() {
	// Start background status collector
	startStatusCollector()

	// API endpoint
	http.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")

		historyMutex.RLock()
		defer historyMutex.RUnlock()

		// If no history yet, fetch current status on-demand
		if len(statusHistory) == 0 {
			status, err := getSystemStatus()
			if err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
				return
			}
			json.NewEncoder(w).Encode([]*SystemStatus{status})
			return
		}

		json.NewEncoder(w).Encode(statusHistory)
	})

	// Static files handler
	staticFS, err := fs.Sub(staticEmbedFS, "static")
	if err != nil {
		log.Fatalf("failed to open static subdirectory: %v", err)
	}
	http.Handle("/", http.FileServer(http.FS(staticFS)))

	port := ":8080"
	fmt.Printf("Servidor corriendo en http://localhost%s\n", port)
	if err := http.ListenAndServe(port, nil); err != nil {
		log.Fatalf("Error iniciando servidor: %v", err)
	}
}
