import SwiftUI

@main
struct TestFixtureApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @State private var count = 0
    @State private var textInput = ""
    @State private var submittedText = ""
    @State private var isLoading = false
    @State private var asyncDone = false

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("Flow A: Counter")) {
                    Text("Count: \(count)")
                        .accessibilityIdentifier("counter_label")
                    Button("Increment Counter") {
                        count += 1
                    }
                    .accessibilityIdentifier("counter_button")
                }

                Section(header: Text("Flow B: Text Input")) {
                    TextField("Enter text here", text: $textInput)
                        .accessibilityIdentifier("text_field")
                    Button("Submit Text") {
                        submittedText = textInput
                    }
                    .accessibilityIdentifier("submit_text_button")
                    Text("Submitted: \(submittedText)")
                        .accessibilityIdentifier("submitted_text_label")
                }

                Section(header: Text("Flow C: Navigation")) {
                    NavigationLink("Open Detail Screen", destination: DetailView())
                        .accessibilityIdentifier("nav_link")
                }

                Section(header: Text("Flow D: Long List")) {
                    NavigationLink("Open Long Scrollable List", destination: LongListView())
                        .accessibilityIdentifier("open_list_link")
                }

                Section(header: Text("Flow E: Async Wait")) {
                    if isLoading {
                        ProgressView("Loading...")
                            .accessibilityIdentifier("loading_spinner")
                    } else if asyncDone {
                        Text("Task Completed Successfully")
                            .accessibilityIdentifier("async_result_label")
                    }
                    Button("Trigger Async Task") {
                        isLoading = true
                        asyncDone = false
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                            isLoading = false
                            asyncDone = true
                        }
                    }
                    .accessibilityIdentifier("async_button")
                }
            }
            .navigationTitle("IDB Evaluation")
        }
    }
}

struct DetailView: View {
    var body: some View {
        VStack(spacing: 20) {
            Text("Detail Screen Content")
                .font(.title)
                .accessibilityIdentifier("detail_screen_title")
            Text("Navigated successfully via IDB")
                .accessibilityIdentifier("detail_screen_body")
        }
        .navigationTitle("Detail")
    }
}

struct LongListView: View {
    @State private var selectedRow = "None"
    var body: some View {
        VStack {
            Text("Selected: \(selectedRow)")
                .accessibilityIdentifier("selected_row_label")
            List(1...60, id: \.self) { num in
                Button("Row item \(num)") {
                    selectedRow = "Row \(num)"
                }
                .accessibilityIdentifier("row_item_\(num)")
            }
        }
        .navigationTitle("Long List")
    }
}
