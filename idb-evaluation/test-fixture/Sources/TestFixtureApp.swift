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
            NavigationLink("Open Interaction Lab", destination: InteractionLab())
                .accessibilityIdentifier("lab_link")
        }
        .navigationTitle("Detail")
    }
}

struct InteractionLab: View {
    @State private var toggle = false
    @State private var text = ""
    @State private var password = ""
    @State private var result = "None"
    @State private var sheet = false
    @State private var alert = false
    @State private var pressed = false

    var body: some View {
        Form {
            Section("Controls") {
                Toggle("Enable option", isOn: $toggle).accessibilityIdentifier("lab_toggle")
                Text(toggle ? "Option: On" : "Option: Off").accessibilityIdentifier("toggle_result")
                TextField("Unicode text", text: $text).accessibilityIdentifier("lab_text")
                SecureField("Password", text: $password).accessibilityIdentifier("lab_secure")
                Button("Read fields") { result = text + " | length: \(password.count)" }
                    .accessibilityIdentifier("lab_submit")
                Text(result).accessibilityIdentifier("lab_result")
            }
            Section("Identity and gestures") {
                Button("Same label") { result = "First duplicate" }.accessibilityIdentifier("duplicate_first")
                Button("Same label") { result = "Second duplicate" }.accessibilityIdentifier("duplicate_second")
                Button("Disabled control") { result = "WRONG: disabled" }
                    .disabled(true).accessibilityIdentifier("disabled_button")
                Text(pressed ? "Long press: Done" : "Hold here")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .accessibilityIdentifier("long_press_target")
                    .onLongPressGesture(minimumDuration: 0.5) { pressed = true }
            }
            Section("Dialogs") {
                Button("Open sheet") { sheet = true }.accessibilityIdentifier("sheet_button")
                Button("Open alert") { alert = true }.accessibilityIdentifier("alert_button")
            }
        }
        .navigationTitle("Interaction Lab")
        .sheet(isPresented: $sheet) {
            VStack {
                Text("Modal content").accessibilityIdentifier("modal_title")
                Button("Close sheet") { sheet = false }.accessibilityIdentifier("modal_close")
            }
        }
        .alert("Test alert", isPresented: $alert) {
            Button("Confirm") { result = "Alert confirmed" }.accessibilityIdentifier("alert_confirm")
            Button("Cancel", role: .cancel) { }
        }
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
