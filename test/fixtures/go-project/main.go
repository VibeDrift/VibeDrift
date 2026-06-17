package main

import (
	"fmt"
	"net/http"
	"os"

	"github.com/gorilla/mux"
)

func main() {
	r := mux.NewRouter()
	r.HandleFunc("/users", GetUsers).Methods("GET")
	r.HandleFunc("/health", HealthCheck).Methods("GET")

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// TODO: add graceful shutdown
	// FIXME: no TLS configured
	fmt.Printf("Server starting on :%s\n", port)
	http.ListenAndServe(":"+port, r)
}

func GetUsers(w http.ResponseWriter, r *http.Request) {
	db, err := connectDB()
	fmt.Fprintf(w, "users: %v", db)

	data, err := fetchData()
	fmt.Fprintf(w, "data: %v", data)
}

func HealthCheck(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

func connectDB() (string, error) {
	return "db", nil
}

func fetchData() (string, error) {
	return "data", nil
}

func UnusedExport() string {
	return "nobody calls me"
}

func AnotherUnusedExport() string {
	return "nobody calls me either"
}
